// Consultas a la tabla usuarios. Siempre con ? (consulta parametrizada), nunca pegando texto en el SQL.
const bcrypt = require('bcryptjs');

function crearModeloUsuarios(pool) {
  // Regresa el usuario (sin el hash) si la contraseña es correcta, o null si no.
  async function verificar(usuario, contrasena) {
  // Consulta parametrizada: el ? evita que lo escrito se interprete como SQL.
  const [filas] = await pool.query(
    'SELECT id, usuario, nombre, rol, contrasena_hash FROM usuarios WHERE usuario = ?',
    [usuario]
  );
  if (filas.length === 0) return null;

  const fila = filas[0];
  const coincide = await bcrypt.compare(contrasena, fila.contrasena_hash);
  if (!coincide) return null;

  // Se regresa el usuario SIN el hash.
  return { id: fila.id, usuario: fila.usuario, nombre: fila.nombre, rol: fila.rol };
}

  return { verificar };
}

module.exports = { crearModeloUsuarios };
