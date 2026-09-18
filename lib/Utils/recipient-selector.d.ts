export declare const GROUP_RECIPIENT_MODES: {
    readonly ALL: "all";
    readonly ADMINS_ONLY: "admins-only";
    readonly MEMBERS_ONLY: "members-only";
};
export type GroupRecipientMode = (typeof GROUP_RECIPIENT_MODES)[keyof typeof GROUP_RECIPIENT_MODES];
export type GroupRecipientRestriction = {
    recipientMode?: GroupRecipientMode;
    recipientParticipants?: string[];
};
export declare const isGroupAdminParticipant: (participant: {
    admin?: string | null;
}) => boolean;
export declare const selectGroupRecipients: (participants: Array<{
    id?: string;
    admin?: string | null;
}>, mode: GroupRecipientMode) => string[];
export declare const resolveGroupRecipients: (args: {
    options?: GroupRecipientRestriction;
    groupData?: {
        participants?: Array<{
            id?: string;
            admin?: string | null;
        }>;
    };
    jid: string;
}) => {
    mode: string;
    jids: string[];
} | null;
//# sourceMappingURL=recipient-selector.d.ts.map