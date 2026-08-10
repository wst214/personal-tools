FROM python:3.12-slim-bookworm

WORKDIR /app

COPY requirements.txt /app/requirements.txt
# 加长超时；国内网络使用清华镜像
RUN pip install --no-cache-dir --default-timeout=120 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    -r /app/requirements.txt

COPY web/ /app/web/
COPY cases/ /app/cases/

RUN mkdir -p /app/data/runs

ENV FUNC_WEB_HOST=0.0.0.0
ENV FUNC_WEB_PORT=8200
ENV PYTHONUNBUFFERED=1

EXPOSE 8200

CMD ["python", "/app/web/server.py"]
