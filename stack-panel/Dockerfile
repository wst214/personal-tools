FROM docker:27-cli AS docker-src

FROM python:3.12-slim

COPY --from=docker-src /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-src /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

RUN sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://security.debian.org/debian-security|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends maven default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
ENV MYTOOLS_ROOT=/workspace
ENV STACK_PANEL_PORT=5770

EXPOSE 5770

CMD ["python", "app.py"]

