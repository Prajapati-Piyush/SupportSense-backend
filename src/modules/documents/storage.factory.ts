import { StorageService } from "./storage.interface.js";
import { LocalStorageService } from "./local-storage.service.js";

let storageInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!storageInstance) {
    storageInstance = new LocalStorageService();
  }
  return storageInstance;
}

export function setStorageService(service: StorageService): void {
  storageInstance = service;
}

