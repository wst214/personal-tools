FROM probezy/cpolar:latest AS cpolar-src

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates socat \
    && curl -fsSL https://github.com/cloudflare/cloudflared/releases/download/2026.6.1/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && rm -rf /var/lib/apt/lists/*

COPY --from=cpolar-src /usr/local/bin/cpolar /usr/local/bin/cpolar

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV TUNNEL_HOST_GATEWAY=host.docker.internal
ENV TUNNEL_IN_DOCKER=1
ENV CPOLAR_REGION=cn_vip
ENV PYTHONUNBUFFERED=1

EXPOSE 5760

CMD ["python", "app.py"]
