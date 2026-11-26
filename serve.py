# 多线程静态服务：python http.server 默认单线程，并发 chunk 请求会在服务端
# 排队串行化，手机端 8 路并发变成 1 路——这是「走出区域楼要等好几秒」的
# 服务端根因。换 ThreadingHTTPServer，真正并发。
# [2026-11-26 真机加载修复] 加 gzip：chunk JSON 平均 637KB、最大 2.4MB，明文传输
# 在手机网络下一批要十几秒 → 「走出那片区域楼不出来」。gzip 后约 1/5（141KB→26KB），
# 4G 下从十几秒压到 2~3 秒。
import io
import gzip
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', '3100'))  # 默认 3100：发布链路曾不注入 PORT，默认 3000 会撞车

GZIP_EXTS = ('.json', '.js', '.html', '.css', '.txt')

class H(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def end_headers(self):
        if getattr(self, '_gzip_on', False):
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        if self.path.split('?')[0].endswith(('.json', '.glb', '.webp', '.jpg', '.png')):
            self.send_header('Cache-Control', 'public, max-age=86400')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def send_head(self):
        path = self.translate_path(self.path.split('?')[0])
        if os.path.isdir(path):
            return super().send_head()
        ext = os.path.splitext(path)[1].lower()
        if ext not in GZIP_EXTS or 'gzip' not in self.headers.get('Accept-Encoding', ''):
            return super().send_head()
        try:
            with open(path, 'rb') as f:
                raw = f.read()
        except OSError:
            return super().send_head()
        buf = gzip.compress(raw, 5)
        self._gzip_on = True
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if ext == '.json'
                         else 'application/javascript' if ext == '.js'
                         else 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(buf)))
        self.send_header('Last-Modified', self.date_time_string(int(os.path.getmtime(path))))
        self.end_headers()
        return io.BytesIO(buf)
    def log_message(self, *a):  # 静默访问日志，避免高频 IO
        pass

print(f'serving on 0.0.0.0:{PORT}', flush=True)
ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
