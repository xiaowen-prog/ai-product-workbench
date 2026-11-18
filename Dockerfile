FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AI_WORKBENCH_HOST=0.0.0.0

WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY dist /app/dist

EXPOSE 8080
CMD ["sh", "-c", "exec python -m uvicorn app.main:app --app-dir backend --host ${AI_WORKBENCH_HOST:-0.0.0.0} --port ${PORT:-8080}"]
