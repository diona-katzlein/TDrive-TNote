FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-liberation coreutils && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "60", "/usr/bin/soffice"]
