/**
 * Terminal output: colors, status lines, steps and a spinner. Every function
 * degrades to plain lines when stdout is not a TTY (CI logs, pipes, tests).
 */
const tty = Boolean(process.stdout.isTTY);
const color = tty && !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const dim = c('2');
export const bold = c('1');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

const fmt = {
  info: (msg) => `${cyan('›')} ${msg}`,
  ok: (msg) => `${green('✓')} ${msg}`,
  warn: (msg) => `${yellow('!')} ${msg}`,
  error: (msg) => `${red('✗')} ${msg}`,
};

export const info = (msg) => console.log(fmt.info(msg));
export const ok = (msg) => console.log(fmt.ok(msg));
export const warn = (msg) => console.log(fmt.warn(msg));
export const error = (msg) => console.error(fmt.error(msg));
export const step = (msg) => console.log(`\n${bold(msg)}`);

/**
 * Numbered progress steps: `const steps = stepper(6); steps.next('Pushing')`
 * prints "[2/6] Pushing".
 */
export function stepper(total) {
  let n = 0;
  return {
    next(msg) {
      n = Math.min(n + 1, total);
      console.log(`\n${dim(`[${n}/${total}]`)} ${bold(msg)}`);
    },
  };
}

/** "2m 05s" style elapsed time. */
export function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A spinner with elapsed time. Finish it with `succeed`, `warn` or `fail`,
 * which clear the spinner line before printing (no garbled output).
 */
export function spinner(text) {
  const started = Date.now();
  let i = 0;
  let label = text;
  let timer = null;

  const clear = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      process.stdout.write('\r\x1b[K');
    }
  };

  if (tty) {
    timer = setInterval(() => {
      process.stdout.write(`\r${cyan(FRAMES[i++ % FRAMES.length])} ${label} ${dim(elapsed(Date.now() - started))}\x1b[K`);
    }, 80);
  } else {
    console.log(`… ${label}`);
  }

  return {
    update(next) {
      if (next === label) return;
      label = next;
      if (!tty) console.log(`… ${label}`);
    },
    succeed(msg) { clear(); console.log(fmt.ok(`${msg} ${dim(`(${elapsed(Date.now() - started)})`)}`)); },
    warn(msg) { clear(); console.log(fmt.warn(msg)); },
    fail(msg) { clear(); console.error(fmt.error(msg)); },
    stop() { clear(); },
  };
}
