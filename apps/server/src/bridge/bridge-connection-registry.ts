export interface BridgeSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface Connection {
  deviceId: string;
  epoch: number;
  socket: BridgeSocket;
}

export class BridgeConnectionRegistry {
  private readonly connections = new Map<string, Connection>();

  public register(deviceId: string, epoch: number, socket: BridgeSocket): boolean {
    const existing = this.connections.get(deviceId);
    if (existing && existing.epoch >= epoch) {
      return false;
    }
    if (existing) {
      existing.socket.close(4_001, "Superseded by a newer connection epoch");
    }
    this.connections.set(deviceId, { deviceId, epoch, socket });
    return true;
  }

  public remove(deviceId: string, socket: BridgeSocket): void {
    if (this.connections.get(deviceId)?.socket === socket) {
      this.connections.delete(deviceId);
    }
  }

  public send(deviceId: string, message: unknown): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return false;
    }
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  public activeEpoch(deviceId: string): number | undefined {
    return this.connections.get(deviceId)?.epoch;
  }
}
