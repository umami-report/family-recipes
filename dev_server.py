"""ローカル確認用サーバー。

index.html を配信しつつ、/fetch?url=... でレシピページを代わりに取ってくる。
ブラウザは他サイトのページを直接読めない（CORS）ため、その中継役。
本番では同じ役目を Supabase Edge Function が担う。

    python dev_server.py            -> http://localhost:5190
"""

import http.server
import ipaddress
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5190
MAX_BYTES = 8 * 1024 * 1024
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)


def is_public_host(host):
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    return all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/fetch":
            target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            return self.proxy(target)
        return super().do_GET()

    def proxy(self, url):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return self.send_error(400, "bad url")
        if not is_public_host(u.hostname):
            return self.send_error(403, "host not allowed")
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept-Language": "ja,en;q=0.8"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read(MAX_BYTES + 1)
                ctype = r.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            return self.send_error(502, f"upstream {e.code}")
        except Exception:
            return self.send_error(502, "fetch failed")
        if len(body) > MAX_BYTES:
            return self.send_error(413, "too large")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"http://localhost:{PORT}")
    server.serve_forever()
