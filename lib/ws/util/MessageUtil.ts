import { Message } from "../Message";

export class MessageUtil {
  static encode(message: any) {
    return JSON.stringify(message);
  }

  static decode(message: any) {
    const parsed = JSON.parse(message);
    return new Message(parsed.t, parsed.d);
  }
}
