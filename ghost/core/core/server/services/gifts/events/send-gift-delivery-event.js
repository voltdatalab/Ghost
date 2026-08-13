/**
 * @typedef {object} SendGiftDeliveryEventData
 * @prop {string} deliveryId
 */

module.exports = class SendGiftDeliveryEvent {
    /**
     * @param {SendGiftDeliveryEventData} data
     * @param {Date} timestamp
     */
    constructor(data, timestamp) {
        this.data = data;
        this.timestamp = timestamp;
    }

    /**
     * @param {SendGiftDeliveryEventData} data
     * @param {Date} [timestamp]
     */
    static create(data, timestamp) {
        return new SendGiftDeliveryEvent(data, timestamp ?? new Date());
    }
};
