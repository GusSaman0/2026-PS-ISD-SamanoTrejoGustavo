const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { crearModeloUsuarios } = require('./modelos/usuarios.modelo');
const { crearModeloTokens } = require('./modelos/tokens.modelo');

const NOMBRE_COOKIE = 'connect.sid';

function todasLasSesiones(almacen){
  return new Promise((resolve, reject)=>{
    const promesa = almacen.all((error, sesiones)=> (error ? reject(error) : resolve(sesiones)));
    if (promesa && typeof promesa.then === 'function') promesa.then(resolve, reject);
  });
}

function crearApp(config, pool){
  const app = express();
  app.use(express.json());
  const usuarios = crearModeloUsuarios(pool);
  const tokens = crearModeloTokens(pool);

  const almacen = config.almacen === 'memoria'
    ? new session.MemoryStore()
    : new MySQLStore({ createDatabaseTable: false, clearExpired: false }, pool);
  app.locals.almacen = almacen;

  app.use(
    session({
      name: NOMBRE_COOKIE,
      secret: process.env.SESSION_SECRET || 'secreto-solo-para-la-demo',
      store: almacen,
      resave: false,
      saveUninitialized: false,
      rolling: config.rolling,
      cookie: {
        maxAge: config.maxAge || 1000*60*60*24,
        httpOnly: config.httpOnly,
        sameSite: config.sameSite,
        secure: false
      }
    })
  );

  const idCorto = (id) => (id ? `${id.slice(0, 8)}...` : null);

  function vencida(sesion){
    const desde = config.rolling ? sesion.ultimoUso : sesion.creada;
    return Date.now() - desde > config.maxAge;
  }

  function requiereSesion(req, res, next){
    if (req.session.usuario && vencida(req.session)){
      return req.session.destroy(() => {
        res.clearCookie(NOMBRE_COOKIE);
        res.status(401).json({error: '401 Tu sesión ha vencido. Por favor vuelve a ingresar tu usuario'});
      });
    }
    if(!req.session.usuario){
      return res.status(401).json({error: 'No has iniciado sesión'});
    }
    req.session.ultimoUso = Date.now();
    next();
  }

  function requiereRol(rol){
    return (req, res, next) => {
      if(req.session.usuario.rol !== rol){
        return res.status(403).json({error: `403 Eres ${req.session.usuario.usuario}, pero esta ruta solo le pertenece a ${rol}`});
      }
      next();
    };
  }

  app.get('/api/config', (req, res) => res.json(config));

  app.post('/api/visita', (req, res) =>{
    req.session.visitas = (req.session.visitas || 0) + 1;
    res.json({visitas: req.session.visitas, sesion: idCorto(req.sessionID)});
  });

  app.post('/api/login', async (req, res, next)=>{
    try{
      const {usuario, contrasena} = req.body || {};
      const datos = await usuarios.verificar(usuario, contrasena);
      if(!datos) return res.status(401).json({error: 'Usuario o Contraseña incorrecto'});

      const antes = req.session.visitas !== undefined ? idCorto(req.sessionID) : null;
      const visitas = req.session.visitas || 0;

      const guardar = () =>{
        req.session.usuario = datos;
        req.session.visitas = visitas;
        req.session.creada = Date.now();
        req.session.ultimoUso = Date.now();
        req.session.save((error)=>{
          if(error) return next(error);
          res.json({usuario: datos, sesionAntes: antes, sesionDespues: idCorto(req.sessionID)});
        });
      };

      if(config.regenerarAlEntrar){
        req.session.regenerate((error) => (error ? next(error) : guardar()));
      }else{
        guardar();
      }
    }catch(error){
      next(error);
    }
  });

  app.post('/api/logout', (req, res, next)=>{
    req.session.destroy((error)=>{
      if(error) return next(error);
      res.clearCookie(NOMBRE_COOKIE);
      res.json({mensaje: 'Sesión cerrada'});
    });
  });

  app.get('/api/sesion', requiereSesion, (req, res) =>{
    const desde = config.rolling ? req.session.ultimoUso : req.session.creada;
    res.json({
      usuario: req.session.usuario,
      sesion: idCorto(req.sessionID),
      expiraEnSegundos: Math.max(0, Math.round((desde + config.maxAge - Date.now())/1000)),
    });
  });

  app.get('/api/perfil', requiereSesion, (req, res)=>{
    req.session.visitas = (req.session.visitas || 0) + 1;
    res.json({mensaje: `Hola ${req.session.usuario.nombre}`, rol: req.session.usuario.rol, visitas: req.session.visitas});
  });

  app.get('/api/admin/reporte', requiereSesion, requiereRol('admin'), (req, res)=>{
    res.json({reporte: 'Talleres para administrador'});
  });

  app.get('/api/diagnostico/sesiones', async (req, res, next)=>{
    try{
      const sesiones = await todasLasSesiones(almacen);
      const lista = Object.entries(sesiones || {}).map(([id, s]) => ({
        sesion: idCorto(id),
        esLaTuya: id === req.sessionID,
        usuario: s.usuario ? s.usuario.usuario : '(sin iniciar sesion)',
        visitas: s.visitas || 0,
        expira: s.cookie && s.cookie.expires,
      }));
      res.json({almacen: config.almacen, sesiones: lista});
    }catch(error){
      next(error);
    }
  });

  // ---- JWT ----
  const SECRETO_JWT = config.jwtSecreto || process.env.JWT_SECRET || 'secreto-jwt-solo-para-la-demo';

  function firmarToken(usuario){
    return jwt.sign(
      { sub: String(usuario.id), usuario: usuario.usuario, nombre: usuario.nombre, rol: usuario.rol },
      SECRETO_JWT,
      { algorithm: 'HS256', expiresIn: config.jwtExpiraSeg, jwtid: crypto.randomUUID() }
    );
  }

  async function requiereJWT(req, res, next){
    const encabezado = req.headers.authorization || '';
    if(!encabezado.startsWith('Bearer ')){
      return res.status(401).json({error: '401. Falta el token para estar Autorizado'});
    }
    const token = encabezado.slice('Bearer '.length);

    let datos;
    try{
      datos = jwt.verify(token, SECRETO_JWT, { algorithms: ['HS256'] });
    }catch(error){
      if(error.name === 'TokenExpiredError'){
        return res.status(401).json({error: '401 Token expirado por favor renuevalo o vuelve iniciar'});
      }
      return res.status(401).json({error: '401 Token invalido'});
    }
    try{
      if(config.jwtRevocar && (await tokens.estaRevocado(datos.jti))){
        return res.status(401).json({error: '401. Token revocado ya se cerro la sesión'});
      }
    }catch(error){
      return next(error);
    }
    req.jwt = datos;
    next();
  }
  // firmarToken y requiereJWT aún no se usan en rutas (queda para la clase).

  app.use('/api', (req, res)=> res.status(404).json({error: 'Ruta no encontrada'}));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((error, req, res, next)=>{
    console.error(error);
    res.status(500).json({error: 'Error de servidor'});
  });

  return app;
}

module.exports = { crearApp, NOMBRE_COOKIE };