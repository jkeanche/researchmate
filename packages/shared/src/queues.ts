/** Background job queue names shared by the web app and the worker. */
export const QUEUES = {
  email: "email",
  maintenance: "maintenance",
} as const;

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
