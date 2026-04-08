FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml README.md /app/
COPY hivee_hub /app/hivee_hub

RUN pip install --no-cache-dir .

ENTRYPOINT ["hivee-hub"]
CMD ["run"]