import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../WABinary/index.js';
import { generateMessageIDV2 } from './generics.js';
import { getStream, getUrlFromDirectPath } from './messages-media.js';

/**
 * Build the `business_profile` content array for a `w:biz` set query.
 *
 * Kept here (not in the socket layer) so the same builder can be reused by
 * `updateBusinessProfile` and by callers that need the raw BinaryNodes — that is
 * what "expose the structures" means for the profile side: the payload shape is
 * available without going through a socket.
 *
 * Only the fields explicitly present in `args` are emitted, so a partial update
 * (mutation_type=delta) does not clear the others.
 *
 * @param {object} args
 * @param {string} [args.address]
 * @param {string} [args.email]
 * @param {string} [args.description]
 * @param {string[]} [args.websites]
 * @param {{timezone: string, days: Array<{day: string, mode: string, openTimeInMinutes?: number, closeTimeInMinutes?: number}>}} [args.hours]
 * @returns {Array<{tag: string, attrs: object, content?: any}>} BinaryNode content
 */
export const toBusinessProfileNode = (args = {}) => {
    const node = [];
    const simpleFields = ['address', 'email', 'description'];
    node.push(...simpleFields
        .filter(key => args[key] !== undefined && args[key] !== null)
        .map(key => ({
        tag: key,
        attrs: {},
        content: args[key]
    })));
    if (args.websites !== undefined) {
        node.push(...args.websites.map(website => ({
            tag: 'website',
            attrs: {},
            content: website
        })));
    }
    if (args.hours !== undefined) {
        node.push({
            tag: 'business_hours',
            attrs: { timezone: args.hours.timezone },
            content: args.hours.days.map(dayConfig => {
                const base = {
                    tag: 'business_hours_config',
                    attrs: {
                        day_of_week: dayConfig.day,
                        mode: dayConfig.mode
                    }
                };
                if (dayConfig.mode === 'specific_hours') {
                    return {
                        ...base,
                        attrs: {
                            ...base.attrs,
                            open_time: dayConfig.openTimeInMinutes,
                            close_time: dayConfig.closeTimeInMinutes
                        }
                    };
                }
                return base;
            })
        });
    }
    return node;
};
/**
 * Build the `<cover_photo>` delta node used by update/delete of the profile cover.
 *
 * `op: 'update'` needs the upload token triple (id/token/ts) that
 * `updateCoverPhoto` obtains from the media upload; `op: 'delete'` only needs the
 * id.
 *
 * @param {{op: 'update'|'delete', id: string|number, token?: string, ts?: string|number}} coverPhoto
 */
export const toCoverPhotoNode = ({ op, id, token, ts }) => {
    const attrs = { op, id: String(id) };
    if (op === 'update') {
        if (token) {
            attrs.token = token;
        }
        if (ts !== undefined) {
            attrs.ts = String(ts);
        }
    }
    return {
        tag: 'cover_photo',
        attrs,
        content: undefined
    };
};
/**
 * Parse an IQ result of the `w:biz` / `business_profile` namespace into a plain
 * profile object.
 *
 * This is the read side of the profile structures: it walks the BinaryNodes the
 * server returns (`<business_profile><profile>…`) and normalises them. Returns
 * `undefined` when the response carries no profile, which is what the server
 * sends for a number without a business profile.
 *
 * @param {object} node the IQ result node
 * @returns {{wid?: string, address?: string, description: string, website: string[], email?: string, category?: string, categories: string[], coverPhotoId?: string, business_hours: {timezone?: string, business_config?: object[]}}|undefined}
 */
export const parseBusinessProfileNode = (node) => {
    const profileNode = getBinaryNodeChild(node, 'business_profile');
    const profiles = getBinaryNodeChild(profileNode, 'profile');
    if (!profiles) {
        return undefined;
    }
    const address = getBinaryNodeChild(profiles, 'address');
    const description = getBinaryNodeChild(profiles, 'description');
    const websiteNodes = getBinaryNodeChildren(profiles, 'website');
    const email = getBinaryNodeChild(profiles, 'email');
    const categoryNodes = getBinaryNodeChildren(getBinaryNodeChild(profiles, 'categories'), 'category');
    const businessHours = getBinaryNodeChild(profiles, 'business_hours');
    const businessHoursConfig = businessHours
        ? getBinaryNodeChildren(businessHours, 'business_hours_config')
        : undefined;
    const coverPhoto = getBinaryNodeChild(profiles, 'cover_photo');
    // `website` is a repeated node. The original parser read only the first one;
    // reading all of them is additive (the first entry is unchanged) and fixes
    // profiles that list several sites.
    const websites = websiteNodes.map(({ content }) => content?.toString()).filter(Boolean);
    const categories = categoryNodes.map(({ content }) => content?.toString()).filter(Boolean);
    return {
        wid: profiles.attrs?.jid,
        address: address?.content?.toString(),
        description: description?.content?.toString() || '',
        website: websites,
        email: email?.content?.toString(),
        category: categories[0],
        categories,
        coverPhotoId: coverPhoto?.attrs?.id,
        business_hours: {
            timezone: businessHours?.attrs?.timezone,
            business_config: businessHoursConfig?.map(({ attrs }) => attrs)
        }
    };
};
/**
 * Build the `productListInfo` needed to send a multi-product (MPM) catalog
 * card.
 *
 * On the wire there is no `ProductListMessage`: WhatsApp sends an MPM as a
 * `listMessage` with `listType = PRODUCT_LIST` plus this `productListInfo`
 * (productSections + headerImage + businessOwnerJid). This builder produces
 * exactly that shape from a friendlier input, so callers do not have to know the
 * quirk.
 *
 * @param {object} input
 * @param {string} input.businessOwnerJid
 * @param {Array<{title?: string, products: Array<{productId: string}>}>} [input.productSections]
 * @param {{productId?: string, jpegThumbnail?: Uint8Array}} [input.headerImage]
 * @param {Array<{title?: string, products: Array<{productId: string}>}>} [input.sections] alias of productSections
 */
export const toProductListInfo = (input = {}) => {
    const sections = input.productSections || input.sections || [];
    const info = {
        productSections: sections.map(section => ({
            title: section.title,
            products: (section.products || []).map(product => ({
                productId: String(product.productId ?? product.id ?? '')
            }))
        })),
        businessOwnerJid: input.businessOwnerJid
    };
    if (input.headerImage) {
        info.headerImage = {
            productId: input.headerImage.productId,
            jpegThumbnail: input.headerImage.jpegThumbnail
        };
    }
    return info;
};
/**
 * Read a `productListInfo` back into the friendly shape (round-trip of
 * `toProductListInfo`). Useful for inspecting an MPM that arrived.
 */
export const parseProductListInfo = (productListInfo) => {
    if (!productListInfo) {
        return undefined;
    }
    return {
        businessOwnerJid: productListInfo.businessOwnerJid,
        productSections: (productListInfo.productSections || []).map(section => ({
            title: section.title,
            products: (section.products || []).map(product => ({
                productId: product.productId
            }))
        })),
        headerImage: productListInfo.headerImage
            ? {
                productId: productListInfo.headerImage.productId,
                jpegThumbnail: productListInfo.headerImage.jpegThumbnail
            }
            : undefined
    };
};
export const parseCatalogNode = (node) => {
    const catalogNode = getBinaryNodeChild(node, 'product_catalog');
    const products = getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode);
    const paging = getBinaryNodeChild(catalogNode, 'paging');
    return {
        products,
        nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined
    };
};
export const parseCollectionsNode = (node) => {
    const collectionsNode = getBinaryNodeChild(node, 'collections');
    const collections = getBinaryNodeChildren(collectionsNode, 'collection').map(collectionNode => {
        const id = getBinaryNodeChildString(collectionNode, 'id');
        const name = getBinaryNodeChildString(collectionNode, 'name');
        const products = getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode);
        return {
            id,
            name,
            products,
            status: parseStatusInfo(collectionNode)
        };
    });
    return {
        collections
    };
};
export const parseOrderDetailsNode = (node) => {
    const orderNode = getBinaryNodeChild(node, 'order');
    const products = getBinaryNodeChildren(orderNode, 'product').map(productNode => {
        const imageNode = getBinaryNodeChild(productNode, 'image');
        return {
            id: getBinaryNodeChildString(productNode, 'id'),
            name: getBinaryNodeChildString(productNode, 'name'),
            imageUrl: getBinaryNodeChildString(imageNode, 'url'),
            price: +getBinaryNodeChildString(productNode, 'price'),
            currency: getBinaryNodeChildString(productNode, 'currency'),
            quantity: +getBinaryNodeChildString(productNode, 'quantity')
        };
    });
    const priceNode = getBinaryNodeChild(orderNode, 'price');
    const orderDetails = {
        price: {
            total: +getBinaryNodeChildString(priceNode, 'total'),
            currency: getBinaryNodeChildString(priceNode, 'currency')
        },
        products
    };
    return orderDetails;
};
export const toProductNode = (productId, product) => {
    const attrs = {};
    const content = [];
    if (typeof productId !== 'undefined') {
        content.push({
            tag: 'id',
            attrs: {},
            content: Buffer.from(productId)
        });
    }
    if (typeof product.name !== 'undefined') {
        content.push({
            tag: 'name',
            attrs: {},
            content: Buffer.from(product.name)
        });
    }
    if (typeof product.description !== 'undefined') {
        content.push({
            tag: 'description',
            attrs: {},
            content: Buffer.from(product.description)
        });
    }
    if (typeof product.retailerId !== 'undefined') {
        content.push({
            tag: 'retailer_id',
            attrs: {},
            content: Buffer.from(product.retailerId)
        });
    }
    if (product.images.length) {
        content.push({
            tag: 'media',
            attrs: {},
            content: product.images.map(img => {
                if (!('url' in img)) {
                    throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 });
                }
                return {
                    tag: 'image',
                    attrs: {},
                    content: [
                        {
                            tag: 'url',
                            attrs: {},
                            content: Buffer.from(img.url.toString())
                        }
                    ]
                };
            })
        });
    }
    if (typeof product.price !== 'undefined') {
        content.push({
            tag: 'price',
            attrs: {},
            content: Buffer.from(product.price.toString())
        });
    }
    if (typeof product.currency !== 'undefined') {
        content.push({
            tag: 'currency',
            attrs: {},
            content: Buffer.from(product.currency)
        });
    }
    if ('originCountryCode' in product) {
        if (typeof product.originCountryCode === 'undefined') {
            attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT';
        }
        else {
            content.push({
                tag: 'compliance_info',
                attrs: {},
                content: [
                    {
                        tag: 'country_code_origin',
                        attrs: {},
                        content: Buffer.from(product.originCountryCode)
                    }
                ]
            });
        }
    }
    if (typeof product.isHidden !== 'undefined') {
        attrs['is_hidden'] = product.isHidden.toString();
    }
    const node = {
        tag: 'product',
        attrs,
        content
    };
    return node;
};
export const parseProductNode = (productNode) => {
    const isHidden = productNode.attrs.is_hidden === 'true';
    const id = getBinaryNodeChildString(productNode, 'id');
    const mediaNode = getBinaryNodeChild(productNode, 'media');
    const statusInfoNode = getBinaryNodeChild(productNode, 'status_info');
    const product = {
        id,
        imageUrls: parseImageUrls(mediaNode),
        reviewStatus: {
            whatsapp: getBinaryNodeChildString(statusInfoNode, 'status')
        },
        availability: 'in stock',
        name: getBinaryNodeChildString(productNode, 'name'),
        retailerId: getBinaryNodeChildString(productNode, 'retailer_id'),
        url: getBinaryNodeChildString(productNode, 'url'),
        description: getBinaryNodeChildString(productNode, 'description'),
        price: +getBinaryNodeChildString(productNode, 'price'),
        currency: getBinaryNodeChildString(productNode, 'currency'),
        isHidden
    };
    return product;
};
/**
 * Uploads images not already uploaded to WA's servers
 */
export async function uploadingNecessaryImagesOfProduct(product, waUploadToServer, timeoutMs = 30000) {
    product = {
        ...product,
        images: product.images
            ? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs)
            : product.images
    };
    return product;
}
/**
 * Uploads images not already uploaded to WA's servers
 */
export const uploadingNecessaryImages = async (images, waUploadToServer, timeoutMs = 30000) => {
    const results = await Promise.all(images.map(async (img) => {
        if ('url' in img) {
            const url = img.url.toString();
            if (url.includes('.whatsapp.net')) {
                return { url };
            }
        }
        const { stream } = await getStream(img);
        const hasher = createHash('sha256');
        const filePath = join(tmpdir(), 'img' + generateMessageIDV2());
        const encFileWriteStream = createWriteStream(filePath);
        for await (const block of stream) {
            hasher.update(block);
            encFileWriteStream.write(block);
        }
        const sha = hasher.digest('base64');
        const { directPath } = await waUploadToServer(filePath, {
            mediaType: 'product-catalog-image',
            fileEncSha256B64: sha,
            timeoutMs
        });
        await fs.unlink(filePath).catch(err => console.log('Error deleting temp file ', err));
        return { url: getUrlFromDirectPath(directPath) };
    }));
    return results;
};
const parseImageUrls = (mediaNode) => {
    const imgNode = getBinaryNodeChild(mediaNode, 'image');
    return {
        requested: getBinaryNodeChildString(imgNode, 'request_image_url'),
        original: getBinaryNodeChildString(imgNode, 'original_image_url')
    };
};
const parseStatusInfo = (mediaNode) => {
    const node = getBinaryNodeChild(mediaNode, 'status_info');
    return {
        status: getBinaryNodeChildString(node, 'status'),
        canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true'
    };
};
//# sourceMappingURL=business.js.map