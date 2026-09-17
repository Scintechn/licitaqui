# LicitaQui worker — built by GitHub Actions, deployed to Easypanel (spec §13).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
COPY licitaqui/ ./licitaqui/
COPY evaluation/ ./evaluation/

RUN pip install --no-cache-dir .

CMD ["python", "-m", "licitaqui"]
