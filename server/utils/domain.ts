'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
/**
 * Get the correct domain for webhooks and callbacks
 * Works in both development and production environments
 * 
 * Environment Variables:
 * - APP_DOMAIN: Primary domain for the application (e.g., "app.yourdomain.com")
 * - NODE_ENV: Set to "production" in production environments
 */
export function getDomain(fallbackHost?: string): string {
  let domain: string | undefined;
  
  // In development environment, use DEV_DOMAIN for correct webhook URLs
  // This ensures webhooks work correctly during development/testing
  if (process.env.DEV_DOMAIN && process.env.NODE_ENV !== 'production') {
    domain = process.env.DEV_DOMAIN;
  }
  // Check for explicit APP_DOMAIN environment variable (recommended for production)
  else if (process.env.APP_DOMAIN) {
    domain = process.env.APP_DOMAIN;
  }
  // Fallback to the host header from request
  else if (fallbackHost) {
    domain = fallbackHost;
  }
  
  if (!domain) {
    throw new Error('Unable to determine domain for webhooks. Please set APP_DOMAIN environment variable.');
  }
  
  // Ensure domain always has https:// protocol prefix
  // This is required for proper URL generation (webhooks, WebSocket streams, etc.)
  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = 'https://' + domain;
  }
  
  return domain;
}
