export class ApiResponseDto<T> {
  statusCode: number;
  message: string;
  data?: T;
  timestamp: string;
  requestId?: string;

  constructor(partial: Partial<ApiResponseDto<T>>) {
    this.statusCode = partial.statusCode ?? 200;
    this.message = partial.message ?? 'Success';
    this.timestamp = partial.timestamp ?? new Date().toISOString();
    this.data = partial.data;
    this.requestId = partial.requestId;
  }

  static success<T>(
    data: T,
    message = 'Success',
    statusCode = 200,
    requestId?: string,
  ): ApiResponseDto<T> {
    return new ApiResponseDto<T>({
      statusCode,
      message,
      data,
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
}
