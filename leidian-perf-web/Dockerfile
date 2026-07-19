FROM python:3.12-slim-bookworm

# init-schema 子命令依赖 psql
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY python/requirements.txt /app/python/requirements.txt
RUN pip install --no-cache-dir -r /app/python/requirements.txt

COPY python/ /app/python/
COPY sql-postgres/ /app/sql-postgres/
COPY sql-dameng/ /app/sql-dameng/
COPY web/ /app/web/

ENV PERF_WEB_HOST=0.0.0.0
ENV PERF_WEB_PORT=8100
ENV PYTHONUNBUFFERED=1
ENV PGHOST=host.docker.internal
ENV PGPORT=5432
ENV PGDATABASE=leidian_perf
ENV PGUSER=leidian
ENV PGPASSWORD=leidian

EXPOSE 8100

CMD ["python", "/app/web/server.py"]
