#!/usr/bin/env python3
"""Serve a local djrust npm build (djrust/npm/build.sh → npm/pkg) with CORS, for the studio's
?engine=djrust&djrust=http://localhost:<port>/ dev override: develop against an unreleased engine
without touching the pinned CDN version (public/djrust/version.js).

    scripts/serve-djrust-pkg.py ../djrust/npm/pkg 18095
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18095
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root))
    print(f'serving {root} with CORS on http://127.0.0.1:{port}/', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
