// HTTP probe receiver supporting both GET /log?m= and POST /batch (newline-delimited body).
const http = require('http');
const fs = require('fs');
const url = require('url');
const LOG = 'C:\\Users\\Nick\\probe.log';
function ts() { const d = new Date(); return d.toISOString().replace('T',' ').slice(0,23); }
function writeLine(line) {
  process.stdout.write(line);
  try { fs.appendFileSync(LOG, line); } catch (e) { process.stderr.write('append fail: ' + e.message + '\n'); }
}
writeLine(`[${ts()}] [probe] starting LOG=${LOG} pid=${process.pid}\n`);
const srv = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress;
  let body = '';
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (req.url.startsWith('/batch') && body) {
      // body is newline-delimited log lines
      const lines = body.split(/\r?\n/);
      for (const ln of lines) {
        if (ln) writeLine(`[${ts()}] BATCH ${ip} ${ln}\n`);
      }
    } else if (req.url.startsWith('/log')) {
      const q = url.parse(req.url, true).query;
      const m = q.m || '';
      writeLine(`[${ts()}] GET ${ip} ${m}\n`);
    } else {
      writeLine(`[${ts()}] ${req.method} ${req.url} from ${ip}${body ? ' body=' + body.slice(0,500) : ''}\n`);
    }
    try { res.writeHead(200, {'access-control-allow-origin': '*'}); res.end('ok'); } catch (e) {}
  };
  req.on('data', c => { body += c; });
  req.on('end', finish);
  req.on('error', e => { writeLine(`[${ts()}] REQ_ERR ${e.message}\n`); finish(); });
  req.setTimeout(5000, () => { writeLine(`[${ts()}] REQ_TIMEOUT ${req.url}\n`); finish(); });
});
srv.on('error', e => writeLine(`[${ts()}] SRV_ERR ${e.message}\n`));
const PORT = 53017;
srv.listen(PORT, '0.0.0.0', () => {
  writeLine(`[${ts()}] [probe] listening 0.0.0.0:${PORT}\n`);
});
