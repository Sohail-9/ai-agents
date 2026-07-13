#!/usr/bin/env node

import { checkHealth } from './tools/serviceHealthCheck';

// Execute health check when this script is run
checkHealth()
  .then(result => {
    console.log(result);
    process.exit(0);
  })
  .catch(error => {
    console.error('Health check error:', error);
    process.exit(1);
  });