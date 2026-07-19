FROM docker:27-cli AS docker-src

FROM python:3.12-slim

COPY --from=docker-src /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-src /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
ENV MYTOOLS_ROOT=/workspace
ENV STACK_PANEL_PORT=5770

EXPOSE 5770

CMD ["python", "app.py"]
