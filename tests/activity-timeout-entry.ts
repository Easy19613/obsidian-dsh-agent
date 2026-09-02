import { ActivityTimeoutGuard } from '../src/acp/activity-timeout';

async function main(): Promise<void> {
  let failures = 0;
  function check(label: string, condition: boolean, detail = ''): void {
    if (condition) console.log('PASS ' + label + (detail !== '' ? ' — ' + detail : ''));
    else {
      failures += 1;
      console.log('FAIL ' + label + (detail !== '' ? ' — ' + detail : ''));
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  {
    let cancelled = 0;
    const guard = new ActivityTimeoutGuard(35, () => { cancelled += 1; });
    let error = '';
    try {
      await guard.wait(new Promise<string>(() => { /* deliberately never settles */ }));
    } catch (caught) {
      error = String(caught);
    }
    check('activity timeout: idle request is cancelled once', cancelled === 1, String(cancelled));
    check('activity timeout: error identifies inactivity rather than total duration', error.includes('request inactivity timeout'), error);
  }

  {
    let cancelled = 0;
    const guard = new ActivityTimeoutGuard(45, () => { cancelled += 1; });
    const progress = setInterval(() => guard.touch(), 20);
    const result = await guard.wait(new Promise<string>((resolve) => {
      setTimeout(() => resolve('completed'), 125);
    }));
    clearInterval(progress);
    check('activity timeout: ongoing progress may exceed the window', result === 'completed' && cancelled === 0,
      JSON.stringify({ result, cancelled }));
  }

  {
    let cancelled = 0;
    const guard = new ActivityTimeoutGuard(0, () => { cancelled += 1; });
    const result = await guard.wait(sleep(30).then(() => 'unlimited'));
    check('activity timeout: zero keeps unlimited behavior', result === 'unlimited' && cancelled === 0);
  }

  if (failures > 0) {
    console.error(failures + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('activity-timeout: all assertions passed');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
