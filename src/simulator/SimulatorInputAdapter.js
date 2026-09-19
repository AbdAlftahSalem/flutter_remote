/**
 * Flutter Remote WebRTC V2 Simulator Input Adapter Interface
 */

export class SimulatorInputAdapter {
  async pointer(event) {
    throw new Error('pointer() must be implemented by subclass');
  }

  async keyboard(event) {
    throw new Error('keyboard() must be implemented by subclass');
  }

  async scroll(event) {
    throw new Error('scroll() must be implemented by subclass');
  }

  async clipboard(text) {
    throw new Error('clipboard() must be implemented by subclass');
  }

  async close() {
    // Optional cleanup
  }
}
