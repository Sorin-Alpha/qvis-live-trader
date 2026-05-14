"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * @param {string} root 应用静态根目录（含 index.html）
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
function startStaticServer(root, port) {
  const rootNorm = path.resolve(root);

  function safeFile(reqPath) {
    const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
    let rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = path.resolve(rootNorm, rel);
    const relToRoot = path.relative(rootNorm, full);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      return null;
    }
    return full;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const filePath = safeFile(u.pathname);
      if (!filePath) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
      });
    });

    const onListenErr = (err) => {
      server.removeListener("error", onListenErr);
      reject(err);
    };
    server.once("error", onListenErr);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onListenErr);
      console.error(`[QVIS] Static UI http://127.0.0.1:${port}/`);
      resolve(server);
    });
  });
}

module.exports = { startStaticServer };
