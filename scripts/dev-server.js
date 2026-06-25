process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.AUTH_BYPASS = 'false';
process.env.AUTH_ENABLED = process.env.AUTH_ENABLED ?? 'true';

require('../server');
