/**
 * Flutter Remote Port Manager
 *
 * Centralized port configuration, collision detection, and dynamic allocation.
 */

import net from 'node:net';
import { PORTS } from '../shared/constants.js';
import { SessionError } from '../shared/errors.js';

export class PortManager {
  constructor(initialPorts = {}) {
    this.ports = {
      gateway: initialPorts.gateway || PORTS.GATEWAY,
      preview: initialPorts.preview || PORTS.PREVIEW,
      signaling: initialPorts.signaling || PORTS.SIGNALING,
      agent: initialPorts.agent || PORTS.AGENT,
    };
    this.allocatedDynamicPorts = new Set();
    this.validateNoCollisions();
  }

  setPort(service, port) {
    const num = Number(port);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new SessionError(`Invalid port for ${service}: ${port}. Must be integer between 1 and 65535.`);
    }
    this.ports[service] = num;
    this.validateNoCollisions();
    return num;
  }

  getPort(service) {
    return this.ports[service];
  }

  getAllPorts() {
    return { ...this.ports };
  }

  validateNoCollisions() {
    const seen = new Map();
    for (const [service, port] of Object.entries(this.ports)) {
      if (port === undefined || port === null || port === 0) continue;
      if (seen.has(port)) {
        throw new SessionError(
          `Port collision detected: services '${seen.get(port)}' and '${service}' both configured to use port ${port}`
        );
      }
      seen.set(port, service);
    }
    return true;
  }

  /**
   * Probes whether a port is currently available for listening.
   */
  async isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();

      server.once('error', () => {
        resolve(false);
      });

      server.listen(port, host, () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }

  /**
   * Finds an available port starting from startPort.
   */
  async findAvailablePort(startPort = 3300, host = '127.0.0.1') {
    let port = startPort;
    while (port < 65535) {
      const isFree = await this.isPortAvailable(port, host);
      if (isFree && !Object.values(this.ports).includes(port) && !this.allocatedDynamicPorts.has(port)) {
        this.allocatedDynamicPorts.add(port);
        return port;
      }
      port++;
    }
    throw new SessionError('No available ports found in range');
  }

  releasePort(port) {
    this.allocatedDynamicPorts.delete(port);
  }

  releaseAll() {
    this.allocatedDynamicPorts.clear();
  }
}

export const portManager = new PortManager();
