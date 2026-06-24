// api/_utils/budget.js
const MAX_REQUESTS = 20;

export class RequestBudget {
    constructor(max = MAX_REQUESTS) {
        this.max = max;
        this.used = 0;
        this.log = [];
    }

    spend(label, count = 1) {
        this.used += count;
        this.log.push({ label, count, total: this.used });
        if (this.used > this.max) {
            console.warn(`[Budget] OVER BUDGET: ${this.used}/${this.max} after "${label}"`);
        }
        return this.remaining() >= 0;
    }

    remaining() {
        return this.max - this.used;
    }

    report() {
        return { used: this.used, max: this.max, log: this.log };
    }
}
