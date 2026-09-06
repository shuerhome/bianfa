// dist/worker.js —— pg-boss 后台任务进程入口。骨架：连接队列并空转；任务在后续阶段注册。
console.log(JSON.stringify({ level: "info", msg: "worker starting (skeleton)" }));
const stop = () => process.exit(0);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 60_000);
