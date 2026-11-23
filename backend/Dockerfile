FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_BACKEND=cloudbase_rest \
    AGENT_DATA_DIR=/data \
    AGENT_DB_PATH=/data/agent_workbench.sqlite3 \
    AGENT_ARTIFACT_DIR=/data/artifacts

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/artifacts \
    && chown -R appuser:appuser /app /data

COPY app ./app

USER appuser
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
