const checkDatabase = async (pool) => {
  const result = { status: 'unknown' };
  try {
    await pool.query('SELECT 1');
    result.status = 'ok';
  } catch (error) {
    result.status = 'error';
    result.error = error.message;
  }
  return result;
};

const checkEndpoint = async (url, timeoutMs) => {
  if (!url) return { status: 'skipped' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.ok ? 'ok' : 'error', statusCode: response.status };
  } catch (error) {
    return { status: 'error', error: error.type === 'aborted' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
};

const buildHealthHandlers = ({ pool, config }) => {
  const readiness = async (req, res) => {
    const [db, wallet, custody] = await Promise.all([
      checkDatabase(pool),
      checkEndpoint(config.health.walletServiceUrl, config.health.timeoutMs),
      checkEndpoint(config.health.custodyServiceUrl, config.health.timeoutMs),
    ]);

    const failing = [db, wallet, custody].some((check) => check.status === 'error');
    const status = failing ? 'unhealthy' : 'ok';
    res.status(failing ? 503 : 200).json({ status, database: db, wallet, custody });
  };

  const health = (_req, res) => res.json({ status: 'ok', exchange_id: config.exchange.id });

  return { health, readiness };
};

module.exports = {
  buildHealthHandlers,
};
