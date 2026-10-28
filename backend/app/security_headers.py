"""Security headers on every API response (pure ASGI, so streamed downloads are not buffered)."""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

BASE_HEADERS = {
    b"x-content-type-options": b"nosniff",
    b"referrer-policy": b"strict-origin-when-cross-origin",
    b"x-frame-options": b"DENY",
    b"content-security-policy": b"frame-ancestors 'none'",
    b"cross-origin-opener-policy": b"same-origin",
    b"permissions-policy": b"camera=(), microphone=(), geolocation=()",
}
HSTS = (b"strict-transport-security", b"max-age=31536000; includeSubDomains")


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, hsts: bool = False) -> None:
        self.app = app
        self.extra = dict(BASE_HEADERS)
        if hsts:
            self.extra[HSTS[0]] = HSTS[1]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                headers += [(k, v) for k, v in self.extra.items() if k not in present]
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)
