FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --default-timeout=300 -r requirements.txt

COPY . .

ENV DATA_DIR=/data
ENV PORT=5757
ENV SSH_KEYS_DIR=/ssh-keys

RUN mkdir -p /data /ssh-keys

EXPOSE 5757

CMD ["gunicorn", "--bind", "0.0.0.0:5757", "--workers", "1", "--threads", "4", "--timeout", "120", "app:app"]
