const path = require('path');
const http= require('http');
const fs = require('fs');
const readline = require('readline');
const {WebSocketServer}= require('ws');

const PUERTO = 7000;

const servidorhttp = http.createServer((req, res) => {
    fs.readFileSync(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) {
            return res.end('Error al cargar el archivo HTML');
        }
        res.writeHead(200, {'Content-Type': 'text/html; charset-UTF-8'});
        res.end(data);
    });
});
const wss = new WebSocketServer({server: servidorhttp});
const clientes = new Set();

