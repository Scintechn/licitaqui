# LicitaQui worker — built by GitHub Actions, deployed to Easypanel (spec §13).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WORKER_PORT=8080

WORKDIR /app

COPY pyproject.toml ./
COPY licitaqui/ ./licitaqui/
COPY evaluation/ ./evaluation/

RUN pip install --no-cache-dir .

# The worker needs no write access to the image and no root.
RUN useradd --system --uid 10001 --no-create-home worker
USER worker

# /health and the authenticated /wake (spec §5.1).
EXPOSE 8080

# Answers from process state only, so it never wakes the Neon compute.
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import os,sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('WORKER_PORT','8080')+'/health',timeout=5).status==200 else 1)"

# Exec form: python is PID 1 and receives Easypanel's SIGTERM, so the job in
# flight finishes before the container exits.
CMD ["python", "-m", "licitaqui"]
