import { spawn } from 'node:child_process';

const children = new Set();
let shuttingDown = false;

function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });

  children.add(child);

  child.on('exit', (code, signal) => {
    children.delete(child);

    if (shuttingDown) return;

    shuttingDown = true;
    for (const runningChild of children) {
      runningChild.kill('SIGTERM');
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  child.on('error', (error) => {
    console.error(`${name} failed to start`, error);
    process.exit(1);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  for (const child of children) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

run('api', process.execPath, ['server/apiServer.ts']);
run('vite', 'pnpm', ['vite']);
