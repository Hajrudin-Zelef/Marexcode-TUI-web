#!/usr/bin/env python3
"""Generate the Content-Security-Policy header for the Marexcode page.

The page is a single HTML file with one inline <style> and one inline <script>.
Scripts stay strict thanks to sha256 hashes. Styles allow 'unsafe-inline' because
Monaco injects its own <style> elements at runtime (hashes cannot cover them).
Monaco workers are loaded from the same origin (and blob URLs).
Re-run it (via marexcode-web-deploy) after every change to index.html.
"""
import base64
import hashlib
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/var/www/marexcode-web/index.html"
with open(path, "r", encoding="utf-8") as fh:
    html = fh.read()


def digest(text: str) -> str:
    value = base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")
    return "'sha256-%s'" % value


scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
script_src = " ".join(["'self'"] + [digest(s) for s in scripts])

csp = "; ".join([
    "default-src 'none'",
    "script-src " + script_src,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
]) + ";"

print('add_header Content-Security-Policy "%s" always;' % csp)
