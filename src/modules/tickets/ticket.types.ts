export type TicketStatus =
  | "NEW"
  | "AI_PROCESSING"
  | "AWAITING_STAFF_REVIEW"
  | "ESCALATED"
  | "AWAITING_CUSTOMER"
  | "RESOLVED"
  | "CLOSED";

export type TicketCategory =
  | "BILLING"
  | "TECHNICAL"
  | "ACCOUNT"
  | "ORDERS"
  | "RETURNS"
  | "SECURITY"
  | "OTHER";

export type TicketPriority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

export type AuthorType = "CUSTOMER" | "STAFF" | "SYSTEM";

export interface TicketRow {
  id: string;
  reference: number;
  tenant_id: string;
  customer_id: string;
  subject: string;
  status: TicketStatus;
  category: TicketCategory | null;
  priority: TicketPriority | null;
  assigned_team_id: string | null;
  assignee_id: string | null;
  in_kb: boolean;
  unread_for_customer: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TicketMessageRow {
  id: string;
  ticket_id: string;
  author_type: AuthorType;
  author_id: string | null;
  author_name: string;
  author_title: string | null;
  body: string;
  created_at: Date;
}

export interface Ticket {
  id: string;
  reference: number;
  tenantId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  subject: string;
  status: TicketStatus;
  category: TicketCategory | null;
  priority: TicketPriority | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  inKb: boolean;
  unreadForCustomer: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
  messageCount: number;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  authorType: AuthorType;
  authorId: string | null;
  authorName: string;
  authorTitle: string | null;
  body: string;
  createdAt: string;
}

export interface CustomerTicketDetail {
  ticket: Ticket;
  messages: TicketMessage[];
}

export interface DeskTicketDetail {
  ticket: Ticket;
  messages: TicketMessage[];
  classification: any | null;
  draft: any | null;
  citations: any[];
  rejectedEvidence: any[];
  reviewHistory: any[];
}

export interface DeskQueueFilters {
  q?: string;
  aiState?: string;
  priority?: string;
  category?: string;
  assignment?: string;
  teamId?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

