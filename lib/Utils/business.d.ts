/**
 * Uploads images not already uploaded to WA's servers
 */
export function uploadingNecessaryImagesOfProduct(product: any, waUploadToServer: any, timeoutMs?: number): Promise<any>;
/**
 * Build the `business_profile` content array for a `w:biz` set query.
 */
export function toBusinessProfileNode(args?: any): {
    tag: string;
    attrs: {};
    content: any;
}[];
/**
 * Build the `<cover_photo>` delta node used by update/delete of the profile cover.
 */
export function toCoverPhotoNode({ op, id, token, ts }: {
    op: 'update' | 'delete';
    id: string | number;
    token?: string;
    ts?: string | number;
}): {
    tag: string;
    attrs: {
        token?: undefined;
        ts?: undefined;
        op: string;
        id: string;
    } | {
        token: string;
        ts: string;
        op: string;
        id: string;
    };
    content: undefined;
};
/**
 * Parse an IQ result of the `w:biz` / `business_profile` namespace into a plain
 * profile object. Returns `undefined` when there is no profile.
 */
export function parseBusinessProfileNode(node: any): {
    wid: any;
    address: any;
    description: any;
    website: any[];
    email: any;
    category: any;
    categories: any[];
    coverPhotoId: any;
    business_hours: {
        timezone: any;
        business_config: any[];
    };
};
/**
 * Build the `productListInfo` needed to send a multi-product (MPM) catalog card.
 */
export function toProductListInfo(input?: any): {
    productSections: {
        title: any;
        products: {
            productId: string;
        }[];
    }[];
    businessOwnerJid: any;
    headerImage?: undefined;
} | {
    productSections: {
        title: any;
        products: {
            productId: string;
        }[];
    }[];
    businessOwnerJid: any;
    headerImage: {
        productId: any;
        jpegThumbnail: any;
    };
};
/**
 * Read a `productListInfo` back into the friendly shape (round-trip of
 * `toProductListInfo`).
 */
export function parseProductListInfo(productListInfo: any): {
    businessOwnerJid: any;
    productSections: {
        title: any;
        products: {
            productId: any;
        }[];
    }[];
    headerImage: {
        productId: any;
        jpegThumbnail: any;
    };
};
export function parseCatalogNode(node: any): {
    products: any;
    nextPageCursor: any;
};
export function parseCollectionsNode(node: any): {
    collections: any;
};
export function parseOrderDetailsNode(node: any): {
    price: {
        total: number;
        currency: any;
    };
    products: any;
};
export function toProductNode(productId: any, product: any): {
    tag: string;
    attrs: {
        compliance_category: string;
        is_hidden: any;
    };
    content: {
        tag: string;
        attrs: {};
        content: any;
    }[];
};
export function parseProductNode(productNode: any): {
    id: any;
    imageUrls: {
        requested: any;
        original: any;
    };
    reviewStatus: {
        whatsapp: any;
    };
    availability: string;
    name: any;
    retailerId: any;
    url: any;
    description: any;
    price: number;
    currency: any;
    isHidden: boolean;
};
export function uploadingNecessaryImages(images: any, waUploadToServer: any, timeoutMs?: number): Promise<any[]>;
//# sourceMappingURL=business.d.ts.map