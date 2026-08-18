import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

@Injectable()
export class RequestContextService {
  private readonly asyncLocalStorage = new AsyncLocalStorage<
    Map<string, any>
  >();

  run(context: Map<string, any>, callback: () => void): void {
    this.asyncLocalStorage.run(context, callback);
  }

  get(key: string): unknown {
    const store = this.asyncLocalStorage.getStore();
    return store ? (store.get(key) as unknown) : undefined;
  }

  set(key: string, value: any): void {
    const store = this.asyncLocalStorage.getStore();
    if (store) {
      store.set(key, value);
    }
  }

  getRequestId(): string | undefined {
    const id = this.get('requestId');
    return typeof id === 'string' ? id : undefined;
  }
}
