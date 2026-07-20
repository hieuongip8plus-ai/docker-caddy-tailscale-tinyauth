FROM tsl0922/ttyd:alpine

RUN --mount=type=cache,target=/var/cache/apk apk add bash git openssh-client tmux

WORKDIR /workspace

CMD ["ttyd", "--writable", "--port", "7681", "tmux", "new-session", "-A", "-s", "webssh"]
