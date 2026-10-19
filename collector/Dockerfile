# 打卡收集器
#   base：執行環境與套件
#   test：加上 pytest 與測試程式（開發用）
#   runtime：正式執行，以非 root 使用者常駐

FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Taipei \
    PYTHONPATH=/app/src
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ src/

FROM base AS test
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY pyproject.toml .
COPY tests/ tests/
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
RUN useradd --uid 10001 --create-home collector \
    && mkdir -p /data \
    && chown collector /data
USER collector
CMD ["python", "-m", "collector", "run"]
