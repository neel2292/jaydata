$data.Class.define('$data.JayService.Middleware', null, null, null, {
    appID: function(config){
        if (!config) config = {};
        return function(req, res, next){
            var appId = req.headers['x-appid'] || config.appid;
            if (!appId) console.warn('Application ID missing.');
            delete req.headers['x-appid'];
            
            Object.defineProperty(req, 'getAppId', {
                value: (function(){
                    return appId;
                }).bind(appId),
                enumerable: true
            });
            
            next();
        };
    },
    superadmin: function(config){
        if (!config) config = {};
        return function(req, res, next){
            var isAdmin = !!req.headers['x-admin'] || config.superadmin;
            delete req.headers['x-admin'];
            
            Object.defineProperty(req, 'isAdmin', {
                value: (function(){
                    return isAdmin;
                }).bind(isAdmin),
                enumerable: true
            });
            
            Object.defineProperty(req, 'authSuperadmin', {
                value: (function(req, res, defer){
                    if (!req.headers['x-auth']){ defer.reject('Authentication failed'); return; }
                    require('http').get({
                        host: req.headers['x-auth'],
                        headers: {
                            Authorization: req.headers['authorization']
                        }
                    }, function(res){
                        defer.resolve({
                            superadmin: true,
                            loginStrategy: 'auth'
                        });
                    }).on('error', function(err){
                        res.statusCode = 401;
                        res.setHeader('WWW-Authenticate', 'Basic realm="JayStack Auth"');
                        
                        defer.reject('Unauthorized');
                    });
                }).bind(config)
            });
            
            next();
        };
    },
    currentDatabase: function(config){
        if (!config) config = {};
        return function(req, res, next){
            var db = {
                server: req.headers['x-db-server'] ? JSON.parse(req.headers['x-db-server']) : config.server,
                username: req.headers['x-db-user'] || config.username,
                password: req.headers['x-db-password'] || config.password
            };
            delete req.headers['x-db-server'];
            delete req.headers['x-db-user'];
            delete req.headers['x-db-password'];
            
            Object.defineProperty(req, 'currentDatabaseConfig', {
                value: db,
                enumerable: true
            });
            
            Object.defineProperty(req, 'getCurrentDatabase', {
                value: (function(type, name){
                    return new type({
                        name: 'mongoDB',
                        databaseName: req.getAppId() + '_' + name,
                        server: db.server,
                        username: db.username,
                        password: db.password,
                        user: req.getUser ? req.getUser() : undefined,
                        checkPermission: req.checkPermission
                    });
                }).bind(db),
                enumerable: true
            });
            
            next();
        }
    },
    databaseConnections: function(config){
        if (!config) throw 'Database connections configuration missing.';
        if (!$data.mongoDBDriver) throw 'mongoDB driver missing.';
        
        var connectionFactory = function(name, server){
            return function(appid){
                if (server.length > 1){
                    var replSet = [];
                    for (var i = 0; i < server.length; i++){
                        replSet.push(new $data.mongoDBDriver.Server(server[i].address, server[i].port || 27017, {}));
                    }
                    return new $data.mongoDBDriver.Db((appid ? appid + '_' : '') + name, new $data.mongoDBDriver.ReplSetServers(replSet), {});
                }else return new $data.mongoDBDriver.Db((appid ? appid + '_' : '') + name, new $data.mongoDBDriver.Server(server[0].address, server[0].port || 27017, {}), {});
            };
        };
        
        var dbs = {};
        for (var i in config){
            if (config.hasOwnProperty(i)){
                dbs[i] = connectionFactory(i, config[i]).bind(config);
            }
        }
        
        return function(req, res, next){
            Object.defineProperty(req, 'dbConnections', { value: dbs, enumerable: true });
            next();
        }
    },
    cache: function(config){
        var Q = require('q');
        var cache = {};
        var timer;
        
        var loadCollection = function(req, client, collection){
            var defer = Q.defer();
            
            client.authenticate(req.currentDatabaseConfig.username, req.currentDatabaseConfig.password, function(err, result){
                if (err){
                    defer.reject(err);
                    return;
                }
                
                if (!result){
                    defer.reject('auth fails');
                    return;
                }
                
                collection.find().toArray(function(err, result){
                    if (err){
                        defer.reject(err);
                        return;
                    }
                    
                    defer.resolve(result);
                });
            });
            
            return defer.promise;
        };
        
        var refreshCache = function(req, res, next){
            if (req.dbConnections.ApplicationDB){
                var id = req.getAppId();
                var db = req.dbConnections.ApplicationDB(id);
                
                db.open(function(err, client){
                    if (err){
                        if (next) next();
                        return;
                    }
                    
                    Q.allResolved([
                        loadCollection(req, client, new $data.mongoDBDriver.Collection(client, 'Users')),
                        loadCollection(req, client, new $data.mongoDBDriver.Collection(client, 'Groups')),
                        loadCollection(req, client, new $data.mongoDBDriver.Collection(client, 'Databases')),
                        loadCollection(req, client, new $data.mongoDBDriver.Collection(client, 'EntitySets')),
                        loadCollection(req, client, new $data.mongoDBDriver.Collection(client, 'Permissions'))
                    ]).fail(function(err){
                        console.log(err);
                        client.close();
                        if (next) next(err);
                        else throw err;
                    }).then(function(v){
                        var result = {
                            Users: v[0].valueOf(),
                            Groups: v[1].valueOf(),
                            Databases: v[2].valueOf(),
                            EntitySets: v[3].valueOf(),
                            Permissions: v[4].valueOf()
                        };
                        
                        console.log('Loading cache =>', id);
                        cache[id] = {
                            Users: {},
                            Groups: {},
                            EntitySets: {},
                            Databases: {},
                            Permissions: {},
                            Access: {}
                        };
                        
                        for (var i = 0; i < result.Groups.length; i++){
                            var g = result.Groups[i];
                            cache[id].Groups[g._id.toString()] = g;
                        }
                        
                        for (var i = 0; i < result.Users.length; i++){
                            var u = result.Users[i];
                            if (u.Groups && u.Groups instanceof Array){
                                var groups = [];
                                for (var j = 0; j < u.Groups.length; j++){
                                    groups.push(cache[id].Groups[u.Groups[j].toString()].Name);
                                }
                                u.Groups = groups;
                            }
                            cache[id].Users[u.Login] = u;
                        }
                        
                        for (var i = 0; i < result.EntitySets.length; i++){
                            var es = result.EntitySets[i];
                            cache[id].EntitySets[es._id.toString()] = es;
                        }
                        
                        for (var i = 0; i < result.Databases.length; i++){
                            var d = result.Databases[i];
                            cache[id].Databases[d._id.toString()] = d;
                        }
                        
                        try{
                            for (var i = 0; i < result.Permissions.length; i++){
                                var p = result.Permissions[i];
                                cache[id].Permissions[p._id.toString()] = p;
                                
                                var access = $data.Access.getAccessBitmaskFromPermission(p);
                                
                                var dbIds = p.DatabaseID ? [p.DatabaseID] : result.Databases.map(function(it){ return it.DatabaseID; });
                                var esIds = p.EntitySetID ? [p.EntitySetID] : result.EntitySets.filter(function(it){ return dbIds.indexOf(it.DatabaseID) >= 0; }).map(function(it){ return it.EntitySetID; });
                                
                                for (var d = 0; d < dbIds.length; d++){
                                    for (var e = 0; e < esIds.length; e++){
                                        var db = cache[id].Databases[dbIds[d].toString()].Name;
                                        var es = cache[id].EntitySets[esIds[e].toString()].Name;
                                        var g = cache[id].Groups[p.GroupID.toString()].Name;
                                        
                                        if (!cache[id].Access[db]) cache[id].Access[db] = {};
                                        if (!cache[id].Access[db][es]) cache[id].Access[db][es] = {};
                                        cache[id].Access[db][es][g] = access;
                                    }
                                }
                            }
                        }catch(err){
                            next(err);
                            return;
                        }
                        
                        if (!cache[id].Access.ApplicationDB) cache[id].Access.ApplicationDB = {};
                        if (!cache[id].Access.ApplicationDB.Tests) cache[id].Access.ApplicationDB.Tests = {};
                        cache[id].Access.ApplicationDB.Tests.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Permissions) cache[id].Access.ApplicationDB.Permissions = {};
                        cache[id].Access.ApplicationDB.Permissions.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Databases) cache[id].Access.ApplicationDB.Databases = {};
                        cache[id].Access.ApplicationDB.Databases.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Entities) cache[id].Access.ApplicationDB.Entities = {};
                        cache[id].Access.ApplicationDB.Entities.admin = 63;
                        if (!cache[id].Access.ApplicationDB.ComplexTypes) cache[id].Access.ApplicationDB.ComplexTypes = {};
                        cache[id].Access.ApplicationDB.ComplexTypes.admin = 63;
                        if (!cache[id].Access.ApplicationDB.EventHandlers) cache[id].Access.ApplicationDB.EventHandlers = {};
                        cache[id].Access.ApplicationDB.EventHandlers.admin = 63;
                        if (!cache[id].Access.ApplicationDB.EntityFields) cache[id].Access.ApplicationDB.EntityFields = {};
                        cache[id].Access.ApplicationDB.EntityFields.admin = 63;
                        if (!cache[id].Access.ApplicationDB.EntitySets) cache[id].Access.ApplicationDB.EntitySets = {};
                        cache[id].Access.ApplicationDB.EntitySets.admin = 63;
                        if (!cache[id].Access.ApplicationDB.EntitySetPublications) cache[id].Access.ApplicationDB.EntitySetPublications = {};
                        cache[id].Access.ApplicationDB.EntitySetPublications.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Services) cache[id].Access.ApplicationDB.Services = {};
                        cache[id].Access.ApplicationDB.Services.admin = 63;
                        if (!cache[id].Access.ApplicationDB.ServiceOperations) cache[id].Access.ApplicationDB.ServiceOperations = {};
                        cache[id].Access.ApplicationDB.ServiceOperations.admin = 63;
                        if (!cache[id].Access.ApplicationDB.TypeTemplates) cache[id].Access.ApplicationDB.TypeTemplates = {};
                        cache[id].Access.ApplicationDB.TypeTemplates.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Users) cache[id].Access.ApplicationDB.Users = {};
                        cache[id].Access.ApplicationDB.Users.admin = 63;
                        if (!cache[id].Access.ApplicationDB.Groups) cache[id].Access.ApplicationDB.Groups = {};
                        cache[id].Access.ApplicationDB.Groups.admin = 63;
                        
                        client.close();
                        if (next) next();
                    })
                    .fail(function(err){
                        console.log(err);
                        client.close();
                        if (next) next(err);
                        else throw err;
                    });
                });
            }else next();
        };
        
        return function(req, res, next){
            var id = req.getAppId();
            if (!process.getCache){
                Object.defineProperty(process, 'getCache', {
                    value: (function(){
                        return req.cache;
                    }).bind(req.cache)
                });
            }
            
            if (!process.refreshCache){
                Object.defineProperty(process, 'refreshCache', {
                    value: (function(callback){
                        refreshCache(req, res, callback);
                    }).bind(cache),
                    enumerable: true
                });
            }
            
            if (!timer){
                refreshCache(req, res, function(){
                    Object.defineProperty(req, 'cache', {
                        value: cache[id],
                        enumerable: true
                    });
                    
                    timer = setTimeout(function(){
                        timer = null;
                    }, 60000);
                    
                    next();
                });
            }else{
                Object.defineProperty(req, 'cache', {
                    value: cache[id],
                    enumerable: true
                });
                
                next();
            }
        };
    },
    authentication: function(config){
        var q = require('q');
        var bcrypt = require('bcrypt');
        
        var cache;
        var request;
        var response;
        var db;
        
        function mongoAuthenticate(username, password, strategy) {
            var defer = q.defer();
            
            if (request.isAdmin && request.isAdmin() && request.authSuperadmin){
                request.authSuperadmin(request, response, defer);
                
                return defer.promise;
            }
            
            db.open(function(err, client){
                if (err) { defer.reject(err); return; }
                var collection = $data.mongoDBDriver.Collection(client, 'Users');
                collection.findOne({ Login: username }, {}, function(err, doc){
                    if (err) { defer.reject(err); return; }
                    if (!doc) { defer.reject('No such user'); return; }
                    else bcrypt.compare(password, doc.Password, function(err, ok) {
                        if (err) { defer.reject(err); return; }
                        if (!ok) { defer.reject('Invalid password'); return; }
                        doc.loginStrategy = strategy;
                        doc.superadmin = request.isAdmin ? request.isAdmin() : false;
                        if (doc.Groups && doc.Groups instanceof Array){
                            var groups = [];
                            for (var j = 0; j < doc.Groups.length; j++){
                                groups.push(cache.Groups[doc.Groups[j].toString()].Name);
                            }
                            doc.Groups = groups;
                        }
                        defer.resolve(doc);
                        client.close();
                    });
                });
            });
            
            return defer.promise;
        }
        
        var passport = require('passport'),
            BasicStrategy = require('passport-http').BasicStrategy,
            AnonymousStrategy = require('passport-anonymous').Strategy,
            LocalStrategy = require('passport-local').Strategy;
        
        passport.use(new LocalStrategy(
            function(username, password, done){
                var promise = mongoAuthenticate(username, password, 'local');
                q.when(promise)
                .then( function(result) {
                    done(null, promise.valueOf());
                })
                .fail( function(reason) {
                    done(reason);
                });
            }
        ));
        
        passport.use(new BasicStrategy(
            function(username, password, done) {
                var promise = mongoAuthenticate(username, password, 'basic');
                q.when(promise)
                .then( function(result) {
                    done(null, promise.valueOf());
                })
                .fail( function(reason) {
                    done(reason);
                });
            }
        ));
        
        passport.use(new AnonymousStrategy());
        
        passport.serializeUser(function(user, done) {
            done(null, user);
        });

        passport.deserializeUser(function(user, done) {
            done(null, user);
        });
        
        return function(req, res, next){
            if (!req.getUser){
                Object.defineProperty(req, 'getUser', {
                    value: (function(){
                        if (!req.user || (req.user && req.user.superadmin)){
                            console.log('Anonymous user authenticated.');
                            Object.defineProperty(req, 'user', {
                                value: req.isAdmin && req.isAdmin() ? { superadmin: true, loginStrategy: 'anonymous' } : { anonymous: true },
                                enumerable: true
                            });
                        }
                        return req.user;
                    }).bind(config),
                    enumerable: true
                });
            }
            
            db = req.dbConnections.ApplicationDB(req.getAppId());
            request = req;
            response = res;
            cache = req.cache;
            
            //passport.initialize()(req, res, function() {
                passport.session()(req, res, function() {
                    if (req.isAuthenticated()) { next(); return; }
                    passport.authenticate(['local', 'basic', 'anonymous'], { session: true })(req, res, next);
                });
            //});
        };
    },
    authenticationErrorHandler: function(err, req, res, next) {
        res.statusCode = res.statusCode != 401 ? err.status || 500 : res.statusCode;
        next(err);
    },
    ensureAuthenticated: function(config){
        if (!config) config = {};
        if (!config.message) config.message = 'myrealm';
        
        return function(req, res, next) {
            if (req.isAuthenticated() && req.getUser) { next(); return; }
            res.statusCode = 401;
            res.setHeader('WWW-Authenticate', 'Basic realm="' + config.message + '"');
            next('Unauthorized');
        };
    },
    authorization: function(config){
        if (!config) config = {};
        return function(req, res, next){
            //if (req.getUser && req.getUser()){
                Object.defineProperty(req, 'checkPermission', {
                    value: (function(access, user, entitysets, callback){
                        var pHandler = new $data.PromiseHandler();
                        var clbWrapper = pHandler.createCallback(callback);
                        var pHandlerResult = pHandler.getPromise();
                        
                        if (user.superadmin){
                            clbWrapper.success(true);
                            return pHandlerResult;
                        }
                        
                        if (!user.Groups || !user.Groups.length){
                            //clbWrapper.success(true);
                            clbWrapper.error('Authorization failed');
                            return pHandlerResult;
                        }
                        
                        var currentDbAccess = req.cache.Access[config.databaseName];
                        if (!(entitysets instanceof Array)) entitysets = [entitysets];
                        if (typeof entitysets[0] === 'object') entitysets = entitysets.map(function(it){ return it.name; });
                        
                        var readyFn = function(result){
                            if (result) clbWrapper.success(result);
                            else clbWrapper.error('Authorization failed');
                        };
                        
                        for (var i = 0; i < entitysets.length; i++){
                            var es = currentDbAccess[entitysets[i]];
                            for (var j = 0; j < user.Groups.length; j++){
                                var g = user.Groups[j];
                                var esg = es[g];
                                if (!(esg & access)){
                                    clbWrapper.error('Authorization failed');
                                    return pHandlerResult;
                                }
                            }
                        }
                        
                        clbWrapper.success(true);
                        return pHandlerResult;
                        
                        /*var i = 0;
                        
                        var callbackFn = function(result){
                            if (result) readyFn(result);
                        
                            if (typeof roles[rolesKeys[i]] === 'boolean' && roles[rolesKeys[i]]){
                                if (user.roles[rolesKeys[i]]) readyFn(true);
                                else{
                                    i++;
                                    if (i < rolesKeys.length) callbackFn();
                                    else readyFn(false);
                                }
                            }else if (typeof roles[rolesKeys[i]] === 'function'){
                                var r = roles[rolesKeys[i]].call(user);
                                
                                if (typeof r === 'function') r.call(user, (i < rolesKeys.length ? callbackFn : readyFn));
                                else{
                                    if (r) readyFn(true);
                                    else{
                                        i++;
                                        if (i < rolesKeys.length) callbackFn();
                                        else readyFn(false);
                                    }
                                }
                            }else if (typeof roles[rolesKeys[i]] === 'number'){
                                if (((typeof user.roles[rolesKeys[i]] === 'number' && (user.roles[rolesKeys[i]] & access)) ||
                                    (typeof user.roles[rolesKeys[i]] !== 'number' && user.roles[rolesKeys[i]])) &&
                                    (roles[rolesKeys[i]] & access)) user.roles[rolesKeys[i]] &&  readyFn(true);
                                else{
                                    i++;
                                    if (i < rolesKeys.length) callbackFn();
                                    else readyFn(false);
                                }
                            }
                        };
                        
                        callbackFn();*/
                        
                        return pHandlerResult;
                    }).bind(config)
                });
                
                next();
            //}else next();
        };
    },
    nginxFactory: function(config){
        if (!config){
            console.error('nginx configuration missing.');
            return function(req, res, next){ next(); }
        }
        
        var fs = require('fs');
        
        return function nginxFactory(req, res, next){
            var json = req.body;
            
            console.log('Building nginx configuration.');
            var conf = '';
            conf += 'proxy_cache_path /var/tmp/cache levels=1:2 keys_zone=STATIC:10m inactive=24h  max_size=1g;\n';
            conf += 'map_hash_bucket_size 1024;\n\n';
            conf += 'server{ server_name _ ""; return 444; }\n\n';
            conf += 'map $host $appid{\n';
            console.log('Using application ID =>', json.application.appID);
            conf += '    default ' + json.application.appID + ';\n';
            
            console.log('Using hosts =>', json.application.hosts);
            for (var i = 0; i < json.application.hosts.length; i++){
                conf += '    ' + json.application.hosts[i] + ' ' + json.application.appID + ';\n';
            }
            
            if (json.application.provision){
                console.log('Using provisions.');
                for (var i = 0; i < json.application.provision.applications.length; i++){
                    var p = json.application.provision.applications[i];
                    console.log('Provision ID =>', p.appID, 'using hosts =>', p.hosts);
                    for (var j = 0; j < p.hosts.length; j++){
                        conf += '    ' + p.hosts[j] + ' ' + p.appID + ';\n';
                    }
                }
            }
            
            conf += '}\n\n';
            console.log('Default database server =>', json.application.dataLayer.dbServer);
            conf += 'map $dbnamewithguid $dbserver{\n';
            conf += '    default \'' + JSON.stringify(json.application.dataLayer.dbServer) + '\';\n';
            
            for (var i = 0; i < json.application.dataLayer.databases.length; i++){
                var d = json.application.dataLayer.databases[i];
                console.log('Database server for', d.name, '=>', d.dbServer || json.application.dataLayer.dbServer);
                conf += '    ' + d.name + '-' + json.application.appID + ' \'' + JSON.stringify(d.dbServer || json.application.dataLayer.dbServer) + '\';\n';
            }
            
            if (json.application.provision){
                console.log('Provisioning database servers.');
                for (var i = 0; i < json.application.provision.applications.length; i++){
                    var p = json.application.provision.applications[i];
                    if (p.dataLayer.dbServer){
                        console.log('Provision ID =>', p.appID, ' with database server =>', p.dataLayer.dbServer);
                        conf += '    ~-' + p.appID + ' \'' + JSON.stringify(p.dataLayer.dbServer) + '\';\n';
                    }
                }
            }
            
            conf += '    ~^nodatabase \'\';\n';
            conf += '}\n\n';
            
            conf += 'map $servicename $dbname{\n';
            
            for (var i = 0; i < json.application.serviceLayer.services.length; i++){
                var s = json.application.serviceLayer.services[i];
                console.log('Service =>', s.serviceName, 'using database =>', (s.database || 'nodatabase'));
                conf += '    ' + s.serviceName + ' ' + (s.database || '\'nodatabase\'') + ';\n';
            }
            
            conf += '}\n\n';
            
            conf += 'map $appid $dbuser{\n';
            console.log('Application ID =>', json.application.appID, 'using database user =>', json.application.dataLayer.dbUser);
            conf += '    ' + json.application.appID + ' \'' + json.application.dataLayer.dbUser + '\';\n';
            
            if (json.application.provision){
                console.log('Provisioning database users.');
                for (var i = 0; i < json.application.provision.applications.length; i++){
                    var p = json.application.provision.applications[i];
                    if (p.dataLayer.dbUser){
                        console.log('Provision ID =>', p.appID, 'using database user =>', p.dataLayer.dbUser);
                        conf += '    ' + p.appID + ' \'' + p.dataLayer.dbUser + '\';\n';
                    }
                }
            }
            
            conf += '}\n\n';
            
            conf += 'map $appid $dbpwd{\n';
            console.log('Application ID =>', json.application.appID, 'using database password =>', json.application.dataLayer.dbPwd);
            conf += '    ' + json.application.appID + ' \'' + json.application.dataLayer.dbPwd + '\';\n';
            
            if (json.application.provision){
                console.log('Provisioning database passwords.');
                for (var i = 0; i < json.application.provision.applications.length; i++){
                    var p = json.application.provision.applications[i];
                    if (p.dataLayer.dbPwd){
                        console.log('Provision ID =>', p.appID, 'using database password =>', p.dataLayer.dbPwd);
                        conf += '    ' + p.appID + ' \'' + p.dataLayer.dbPwd + '\';\n';
                    }
                }
            }
            
            conf += '}\n\n';
            
            conf += 'map $serviceorigins $cors{\n';
            conf += '    default "";\n';
            
            for (var i = 0; i < json.application.serviceLayer.services.length; i++){
                var s = json.application.serviceLayer.services[i];
                if (s.outgress && s.outgress.length && !s.outgress.filter(function(it){ return it.origin == '*'; }).length){
                    for (var j = 0; j < s.outgress.length; j++){
                        console.log('Service =>', s.serviceName, 'using origin =>', s.outgress[j].origin);
                        conf += '    ' + s.serviceName + '-' + s.outgress[j].origin + ' ' + s.outgress[j].origin + ';\n';
                    }
                }
            }
            
            conf += '}\n';
            
            var servicesPort = {};
            for (var i = 0; i < json.application.serviceLayer.services.length; i++){
                var s = json.application.serviceLayer.services[i];
                for (var j = 0; j < s.ingress.length; j++){
                    if (!servicesPort[s.ingress[j].port + '_' + s.ingress[j].ssl]) servicesPort[s.ingress[j].port + '_' + s.ingress[j].ssl] = [];
                    servicesPort[s.ingress[j].port + '_' + s.ingress[j].ssl].push(s);
                }
            }
            
            for (var i in servicesPort){
                var sp = servicesPort[i];
                conf += '\nserver{\n';
                conf += '    set $domain storm.jaystack.com;\n';
                console.log('Server listen on =>', require('os').networkInterfaces()['eth0'][0].address + ':' + i.split('_')[0]);
                conf += '    listen ' + require('os').networkInterfaces()['eth0'][0].address + ':' + i.split('_')[0] + ';\n';
                conf += '    server_name ';
                conf += json.application.appID + '.$domain';
                for (var k = 0; k < json.application.hosts.length; k++){
                    conf += ' ' + json.application.hosts[k];
                }
                conf += ';\n';
                
                if (i.split('_')[1] == 'true'){
                    console.log('Server using SSL.');
                    conf += '\n    ssl on;\n';
                    conf += '    ssl_certificate ssl/star_jaystack_net.crt;\n';
                    conf += '    ssl_certificate_key ssl/star_jaystack_net.key;\n';
                    conf += '    ssl_session_timeout 5m;\n';
                    conf += '    ssl_protocols SSLv3 TLSv1;\n';
                    conf += '    ssl_ciphers ALL:!ADH:!EXPORT56:RC4+RSA:+HIGH:+MEDIUM:+LOW:+SSLv3:+EXP;\n';
                    conf += '    ssl_prefer_server_ciphers on;\n';
                }
                
                conf += '\n    location / {\n';
                console.log('Server using static file store at =>', config.filestore);
                conf += '        proxy_pass ' + config.filestore + '/%appid%;\n';
                conf += '        proxy_set_header X-Real-IP $remote_addr;\n';
                conf += '        proxy_cache STATIC;\n';
                conf += '        proxy_cache_valid 200 1d;\n';
                conf += '        proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504;\n';
                conf += '    }\n';
                
                for (var k = 0; k < sp.length; k++){
                    var s = sp[k];
                    
                    console.log('Server publishing service =>', s.serviceName, 'using internal port =>', s.internalPort);
                    conf += '\n    location /joker/' + s.serviceName + '{\n';
                    conf += '        more_clear_headers \'X-Admin\';\n';
                    conf += '        more_clear_headers \'X-Auth\';\n';
                    conf += '        set $servicename ' + s.serviceName + ';\n';
                    conf += '        set $dbnamewithguid $dbname-$appid;\n';
                    conf += '        rewrite ^/joker(.*)$ $1 break;\n';
                    conf += '        proxy_pass http://127.0.0.1:' + s.internalPort + ';\n';
                    conf += '        proxy_set_header Host $host;\n';
                    conf += '        proxy_set_header X-Admin \'superadmin\';\n';
                    conf += '        proxy_set_header X-Auth \'' + config.auth + '\';\n';
                    conf += '        proxy_set_header X-Real-IP $remote_addr;\n';
                    conf += '        proxy_set_header X-AppId $appid;\n';
                    conf += '        proxy_set_header X-Db-Server $dbserver;\n';
                    conf += '        proxy_set_header X-Db-User $dbuser;\n';
                    conf += '        proxy_set_header X-Db-Password $dbpwd;\n';
                    conf += '        more_set_headers \'Access-Control-Allow-Origin: *\';\n';
                    conf += '    }\n';
                    
                    if (s.allowedSubPathList.length == 1 && s.allowedSubPathList[0] == '*'){
                        conf += '\n    location /' + s.serviceName + '{\n';
                        conf += '        more_clear_headers \'X-Admin\';\n';
                        conf += '        more_clear_headers \'X-Auth\';\n';
                        conf += '        set $servicename ' + s.serviceName + ';\n';
                        conf += '        set $serviceorigins $servicename-$http_origin;\n';
                        conf += '        set $dbnamewithguid $dbname-$appid;\n';
                        conf += '        proxy_pass http://127.0.0.1:' + s.internalPort + ';\n';
                        conf += '        proxy_set_header Host $host;\n';
                        conf += '        proxy_set_header X-Real-IP $remote_addr;\n';
                        conf += '        proxy_set_header X-AppId $appid;\n';
                        conf += '        proxy_set_header X-Db-Server $dbserver;\n';
                        conf += '        proxy_set_header X-Db-User $dbuser;\n';
                        conf += '        proxy_set_header X-Db-Password $dbpwd;\n';
                        var ingressPort = s.ingress.filter(function(it){ return it.port.toString() == i.split('_')[0]; })[0];
                        if (ingressPort.address instanceof Array && ingressPort.address.indexOf('*') < 0){
                            conf += '        deny all;\n';
                            for (var l = 0; l < ingressPort.address.length; l++){
                                console.log('Service restricted to =>', ingressPort.address[l]);
                                conf += '        allow ' + ingressPort.address[l] + ';\n';
                            }
                        }
                        if (s.outgress && s.outgress.filter(function(it){ return it.origin == '*'; }).length){
                            console.log('CORS enabled.');
                            conf += '        more_set_headers \'Access-Control-Allow-Origin: *\';\n';
                        }else if (s.outgress){
                            console.log('CORS disabled.');
                            conf += '        more_set_headers \'Access-Control-Allow-Origin: $cors\';\n';
                        }
                        conf += '    }\n';
                    }else{
                        for (var l = 0; l < s.allowedSubPathList.length; l++){
                            console.log('Service =>', s.serviceName, 'publishing entity set =>', s.allowedSubPathList[l], 'using internal port =>', s.internalPort);
                            conf += '\n    location /' + s.serviceName + '/' + s.allowedSubPathList[l] + '{\n';
                            conf += '        more_clear_headers \'X-Admin\';\n';
                            conf += '        more_clear_headers \'X-Auth\';\n';
                            conf += '        set $servicename ' + s.serviceName + ';\n';
                            conf += '        set $serviceorigins $servicename-$http_origin;\n';
                            conf += '        set $dbnamewithguid $dbname-$appid;\n';
                            conf += '        proxy_pass http://127.0.0.1:' + s.internalPort + ';\n';
                            conf += '        proxy_set_header Host $host;\n';
                            conf += '        proxy_set_header X-Real-IP $remote_addr;\n';
                            conf += '        proxy_set_header X-AppId $appid;\n';
                            conf += '        proxy_set_header X-Db-Server $dbserver;\n';
                            conf += '        proxy_set_header X-Db-User $dbuser;\n';
                            conf += '        proxy_set_header X-Db-Password $dbpwd;\n';
                            var ingressPort = s.ingress.filter(function(it){ return it.port.toString() == i.split('_')[0]; })[0];
                            if (ingressPort.address instanceof Array && ingressPort.address.indexOf('*') < 0){
                                conf += '        deny all;\n';
                                for (var m = 0; m < ingressPort.address.length; m++){
                                    console.log('Service restricted to =>', ingressPort.address[m]);
                                    conf += '        allow ' + ingressPort.address[m] + ';\n';
                                }
                            }
                            if (s.outgress && s.outgress.filter(function(it){ return it.origin == '*'; }).length){
                                console.log('CORS enabled.');
                                conf += '        more_set_headers \'Access-Control-Allow-Origin: *\';\n';
                            }else if (s.outgress){
                                console.log('CORS disabled.');
                                conf += '        more_set_headers \'Access-Control-Allow-Origin: $cors\';\n';
                            }
                            conf += '    }\n';
                        }
                    }
                }
                
                conf += '}\n';
            }
            
            console.log('Writing nginx configuration file out to =>', config.filename);
            console.log('Full configuration file =>', conf);
            fs.writeFile(config.filename, conf, function(err){
                if (err){
                    console.log('ERROR =>', err);
                    next(err);
                }else{
                    console.log('ngingx configuration build succeeded.');
                    next();
                }
            });
        };
    },
    sourceFactory: function(config){
        if (!config){
            console.error('Service source code configuration missing.');
            return function(req, res, next){ next(); }
        }
        
        var counter = 1;
        var readyFn = function(next){
            if (!(--counter)){
                next();
                return false;
            }
            
            return true;
        }
        
        var fs = require('fs');
        var cp = require('child_process');
        
        var loader = function(next){
            counter = config.cu.application.serviceLayer.services.length;
            for (var i = 0; i < config.cu.application.serviceLayer.services.length; i++){
                var s = config.cu.application.serviceLayer.services[i];
                
                console.log('Generating source file(s) for service =>', s.serviceName);
                switch (s.sourceType){
                    case 'script':
                        console.log('Creating source file =>', config.path + '/' + s.serviceName + '/index.js', 'with content =>', s.source);
                        fs.writeFile(config.path + '/' + s.serviceName + '/index.js', s.source, function(err){
                            if (err) console.log('ERROR while creating source file =>', config.path + '/' + s.serviceName + '/index.js', '=>', err);
                            readyFn(next);
                        });
                        break;
                    case 'git':
                        console.log('Get source files using git =>', s.source, 'to path =>', config.path + '/' + s.serviceName);
                        cp.exec('git clone ' + s.source + ' ' + config.path + '/' + s.serviceName, function(err, stdout, stderr){
                            if (err){
                                console.log('ERROR while git clone =>', s.source);
                                next(err);
                                return;
                            }
                            if (stdout) console.log(stdout);
                            if (stderr) console.log(stderr);
                            
                            readyFn(next);
                        });
                        break;
                    default:
                        readyFn(next);
                        break;
                }
            }
        };
        
        return function sourceFactory(req, res, next){
            config.cu = req.body;
            console.log('Source factory.');
            fs.exists(config.path, function(exists){
                if (exists){
                    console.log('Removing directoy =>', config.path);
                    cp.exec('rm -rf ' + config.path, function(err, stdout, stderr){
                        if (err){
                            console.log('ERROR while removing directory =>', config.path, '=>', err);
                            next(err);
                            return;
                        }
                        if (stdout) console.log(stdout);
                        if (stderr) console.log(stderr);
                        
                        loader(next);
                    });
                }
                else loader(next);
            });
        };
    },
    contextFactory: function(config){
        if (!config){
            console.error('Context factory configuration missing.');
            return function(req, res, next){ next(); };
        }

        return function contextFactory(req, res, next){
            config.cu = req.body;
            var appdb = config.cu.application.dataLayer.databases.filter(function(it){ return it.name == 'ApplicationDB' })[0];
            if (!appdb){
                next('ApplicationDB missing from databases.');
                return;
            }
            var context = new (config.api)({
                name: 'mongoDB',
                databaseName: config.cu.application.appID + '_ApplicationDB',
                server: appdb.dbServer || config.cu.application.dataLayer.dbServer,
                username: appdb.dbUser || config.cu.application.dataLayer.dbUser,
                password: appdb.dbPwd || config.cu.application.dataLayer.dbPwd
            });
            /*console.log('Building context from =>', config.apiUrl);
            $data.MetadataLoader.debugMode = true;
            $data.MetadataLoader.load(config.apiUrl, function (factory, ctxType, text) {
                var context = factory();*/
                var dbs = config.cu.application.dataLayer.databases.slice();
                //var file = 'exports = module.exports = function(app){\n\n';
                var file = '(function(){\n\n';
                file += 'var contextTypes = {};\n\n';
                var builder = function(db){
                    console.log('Building context =>', db, config.api.fullName);
                    context.getContextJS(db)(function(js){
                        console.log('Context source =>', js);
                        file += (js + '\n\n');
                        var ctxName = js.match(/\$data.EntityContext.extend\(\"(.*)\",/)[1];
                        file += 'contextTypes["' + db + '"] = ' + ctxName + ';\n\n';
                        //file += '\napp.use("/' + db + '", $data.JayService.createAdapter(' + ctxName + ', function(){\n    return new ' + ctxName + '({ name: "mongoDB", databaseName: "' + db + '" });\n}));\n';
                        if (dbs.length) builder(dbs.shift().name);
                        else{
                            //file += '\n});';
                            file += 'exports = module.exports = { contextTypes: contextTypes };\n\n';
                            file += '})();';
                            console.log('Context build completed.');
                            console.log('Writing context file to =>', config.filename, 'with content =>', file);
                            require('fs').writeFile(config.filename, file, function(err){
                                if (err){
                                    console.log('ERROR while writing file =>', config.filename, '=>', err);
                                    next(err);
                                }else{
                                    console.log('Context ready.');
                                    next();
                                }
                            });
                        }
                    }, function(err){
                        next(err);
                    });
                    /*}).fail(function(err){
                        console.log('ERROR while trying to get context source =>', err);
                    });*/
                };
                
                builder(dbs.shift().name);
            //});
        };
    },
    serviceFactory: function(config){
        if (!config){
            console.error('Service factory configuration missing.');
            return function(req, res, next){ next(); };
        }
        
        return function serviceFactory(req, res, next){
            config.cu = req.body;
            
            console.log('Building service.');
            var file = '';
            var fn = function(){
                file += '(function(contextTypes){\n\n';
                file += 'var windowBackup = window;\n';
                file += 'window = undefined;\n';
                file += 'var express = require("express");\n';
                file += 'var passport = require("passport");\n';
                file += 'window = windowBackup;\n\n';
                
                var dbConf = {};
                for (var i = 0; i < config.cu.application.dataLayer.databases.length; i++){
                    var db = config.cu.application.dataLayer.databases[i];
                    dbConf[db.name] = db.dbServer || config.cu.application.dataLayer.dbServer;
                    if (typeof dbConf[db.name] === 'string') dbConf[db.name] = [{ address: dbConf[db.name].split(':')[0], port: dbConf[db.name].split(':')[1] }]
                    if (!(dbConf[db.name] instanceof Array)) dbConf[db.name] = [dbConf[db.name]];
                }
                
                var listen = [];
                for (var i = 0; i < config.cu.application.serviceLayer.services.length; i++){
                    var s = config.cu.application.serviceLayer.services[i];
                    console.log('Service =>', s.serviceName, 'using internal port =>', s.internalPort);
                    if (listen.indexOf(s.internalPort || s.port) < 0){
                        file += 'var app' + (s.internalPort || s.port) + ' = express();\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(express.cookieParser());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(express.methodOverride());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(express.session({ secret: "keyboard cat" }));\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.appID());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.superadmin());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.currentDatabase());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.databaseConnections(' + JSON.stringify(dbConf, null, '    ') + '));\n';
                        /*file += 'app' + (s.internalPort || s.port) + '.use(function (req, res, next){\n';
                        file += '    res.setHeader("Access-Control-Allow-Origin", "*");\n';
                        file += '    res.setHeader("Access-Control-Allow-Headers", "X-PINGOTHER, Content-Type, MaxDataServiceVersion, DataServiceVersion");\n';
                        file += '    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, MERGE");\n';
                        file += '    if (req.method === "OPTIONS") res.end(); else next();\n';
                        file += '});\n';*/
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.cache());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(passport.initialize());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use("/' + s.serviceName + '/logout", function(req, res){\n';
                        file += '    if (req.logOut){\n';
                        file += '        req.logOut();\n';
                        file += '        res.statusCode = 401;\n';
                        file += '        res.setHeader("WWW-Authenticate", "Basic realm=\\"' + s.serviceName + '\\"");\n';
                        file += '        res.write("Logout was successful.");\n';
                        file += '    }else res.write("Logout failed.");\n';
                        file += '    res.end();\n';
                        file += '});\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.authentication());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.authenticationErrorHandler);\n';
                        if (!s.allowAnonymous){
                            console.log('Service =>', s.serviceName, 'ensuring authentication.');
                            file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.ensureAuthenticated({ message: "' + s.serviceName + '" }));\n';
                        }
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.Middleware.authorization({ databaseName: "' + s.database + '" }));\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(express.query());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use(express.bodyParser());\n';
                        file += 'app' + (s.internalPort || s.port) + '.use($data.JayService.OData.Utils.simpleBodyReader());\n';
                        listen.push((s.internalPort || s.port));
                    }
                    if (s.extend) file += '$data.Class.defineEx("' + s.serviceName + '", [' + (s.database ? 'contextTypes["' + s.database + '"]' : s.serviceName) + ', ' + s.extend + ']);\n';
                    else if (s.database) file += '$data.Class.defineEx("' + s.serviceName + '", [' + (s.database ? 'contextTypes["' + s.database + '"], $data.ServiceBase' : s.serviceName) + ']);\n';
                    file += 'if (typeof ' + s.serviceName + ' !== "function") $data.Class.defineEx("' + s.serviceName + '", [$data.ServiceBase]);\n';
                    file += 'app' + (s.internalPort || s.port) + '.use("/' + s.serviceName + '", express.static(__dirname + "/files/' + s.serviceName + '"));\n';
                    if (s.database) console.log('Service =>', s.serviceName, 'using database =>', s.database);
                    file += 'app' + (s.internalPort || s.port) + '.use("/' + s.serviceName + '", $data.JayService.createAdapter(' + s.serviceName + ', function(req, res){\n    return ' + (s.database ? 'req.getCurrentDatabase(' + s.serviceName + ', "' + s.database + '")' : 'new ' + s.serviceName + '()') + ';\n}));\n';
                    file += 'app' + (s.internalPort || s.port) + '.use(express.errorHandler());\n\n';
                    file += 'express.errorHandler.title = "JayStorm API";\n';
                }
                for (var i = 0; i < listen.length; i++){
                    console.log('node.js listening on port =>', listen[i]);
                    file += 'app' + listen[i] + '.listen(' + listen[i] + ', "127.0.0.1");\n';
                }
                file += '\n})(require("' + config.context + '").contextTypes);';
                console.log('Writing service file to =>', config.filename, 'with content =>', file);
                require('fs').writeFile(config.filename, file, function(err){
                    if (err){
                        console.log('ERROR while writing file to =>', config.filename, '=>', err);
                        next(err);
                    }else{
                        console.log('Service ready.');
                        next();
                    }
                });
            };
            
            //TODO: include custom service (git, source)
            /*var src = config.services.filter(function(it){ return !it.database; });
            if (src.length){
                src = src.map(function(it){ return it.serviceName; });
                $data.MetadataLoader.debug = true;
                $data.MetadataLoader.load(config.apiUrl, function (factory, ctxType, text) {
                    var context = factory();
                    context.Services.filter(function(it){ return it.Name in this.services; }, { services: src }).toArray(function(result){
                        var srcInclude = function(src){
                            file += (src + '\n\n');
                        };
                        
                        var srcLoader = function(src){
                            var isHttp = !!src.Source.match('http://');
                            var isHttps = !!src.Source.match('https://');
                            if (isHttp || isHttps){
                                //TODO: request source code
                                var http = isHttps ? require('https') : require('http');
                                var xhttp = http.request({
                                    host:
                                    port:
                                    path:
                                    method: 
                                }, )
                            }else{
                                srcInclude(src.Source);
                                if (result.length) srcLoader(result.shift());
                                else fn();
                            }
                        };
                        
                        if (result.length) srcLoader(result.shift());
                        else fn();
                    });
                });
            }else*/ fn();
        };
    }
});