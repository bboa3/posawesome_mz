// Copyright (c) 2020, Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Closing Shift", {
	onload: function (frm) {
		frm.set_query("pos_profile", function (doc) {
			return {
				filters: { user: doc.user },
			};
		});

		frm.set_query("user", function (doc) {
			return {
				query: "posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.get_cashiers",
				filters: { parent: doc.pos_profile },
			};
		});

		frm.set_query("pos_opening_shift", function (doc) {
			return { filters: { status: "Open", docstatus: 1 } };
		});

		if (frm.doc.docstatus === 0) frm.set_value("period_end_date", frappe.datetime.now_datetime());
		if (frm.doc.docstatus === 1) set_html_data(frm);
	},

	pos_opening_shift(frm) {
		if (frm.doc.pos_opening_shift && frm.doc.user) {
			reset_values(frm);
			frappe.run_serially([
				() => frm.trigger("set_opening_amounts"),
				() => frm.trigger("get_pos_invoices"),
				() => frm.trigger("get_pos_payments"),
			]);
		}
	},

	set_opening_amounts(frm) {
		return frappe.db
			.get_doc("POS Opening Shift", frm.doc.pos_opening_shift)
			.then(({ balance_details }) => {
				balance_details.forEach((detail) => {
					frm.add_child("payment_reconciliation", {
						mode_of_payment: detail.mode_of_payment,
						opening_amount: detail.amount || 0,
						expected_amount: detail.amount || 0,
					});
				});
			});
	},

	get_pos_invoices(frm) {
		frappe.call({
			method: "posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.get_pos_invoices",
			args: {
				pos_opening_shift: frm.doc.pos_opening_shift,
			},
			callback: async (r) => {
				const pos_docs = r.message;
				await set_form_data(pos_docs, frm);
				refresh_fields(frm);
				set_html_data(frm);
			},
		});
	},

	get_pos_payments(frm) {
		frappe.call({
			method: "posawesome.posawesome.doctype.pos_closing_shift.pos_closing_shift.get_payments_entries",
			args: {
				pos_opening_shift: frm.doc.pos_opening_shift,
			},
			callback: (r) => {
				let pos_payments = r.message;
				set_form_payments_data(pos_payments, frm);
				refresh_fields(frm);
				set_html_data(frm);
			},
		});
	},
});

frappe.ui.form.on("POS Closing Shift Detail", {
	closing_amount: (frm, cdt, cdn) => {
		const row = locals[cdt][cdn];
		frappe.model.set_value(cdt, cdn, "difference", flt(row.expected_amount - row.closing_amount));
	},
});

async function set_form_data(data, frm) {
	if (!Array.isArray(data)) {
		return;
	}

	for (const d of data) {
		add_to_pos_transaction(d, frm);
		const conversion_rate = get_conversion_rate(d);
		frm.doc.grand_total += get_base_value(d, "grand_total", "base_grand_total", conversion_rate);
		frm.doc.net_total += get_base_value(d, "net_total", "base_net_total", conversion_rate);
		frm.doc.total_quantity += flt(d.total_qty);
		await add_to_payments(d, frm, conversion_rate);
		add_to_taxes(d, frm, conversion_rate);
	}
}

function set_form_payments_data(data, frm) {
	data.forEach((d) => {
		add_to_pos_payments(d, frm);
		add_pos_payment_to_payments(d, frm);
	});
}

function add_to_pos_transaction(d, frm) {
	const conversion_rate = get_conversion_rate(d);
	const child = {
		posting_date: d.posting_date,
		grand_total: get_base_value(d, "grand_total", "base_grand_total", conversion_rate),
		transaction_currency: d.currency,
		transaction_amount: flt(d.grand_total),
		customer: d.customer,
	};
	if (d.doctype === "POS Invoice") {
		child.pos_invoice = d.name;
	} else {
		child.sales_invoice = d.name;
	}
	frm.add_child("pos_transactions", child);
}

function add_to_pos_payments(d, frm) {
	frm.add_child("pos_payments", {
		payment_entry: d.name,
		posting_date: d.posting_date,
		paid_amount: d.paid_amount,
		customer: d.party,
		mode_of_payment: d.mode_of_payment,
	});
}

async function add_to_payments(d, frm, conversion_rate) {
	const payments = Array.isArray(d.payments) ? d.payments : [];
	const cash_mode_of_payment = await get_cash_mode_of_payment(frm);

	payments.forEach((p) => {
		const payment = frm.doc.payment_reconciliation.find(
			(pay) => pay.mode_of_payment === p.mode_of_payment,
		);
		if (payment) {
			let amount = get_base_value(p, "amount", "base_amount", conversion_rate);

			if (payment.mode_of_payment === cash_mode_of_payment) {
				amount -= get_base_value(d, "change_amount", "base_change_amount", conversion_rate);
			}
			payment.expected_amount += flt(amount);
		} else {
			frm.add_child("payment_reconciliation", {
				mode_of_payment: p.mode_of_payment,
				opening_amount: 0,
				expected_amount: get_base_value(p, "amount", "base_amount", conversion_rate),
			});
		}
	});
}

function add_pos_payment_to_payments(p, frm) {
	const payment = frm.doc.payment_reconciliation.find((pay) => pay.mode_of_payment === p.mode_of_payment);
	if (payment) {
		let amount = get_base_value(p, "paid_amount", "base_paid_amount");
		payment.expected_amount += flt(amount);
	} else {
		frm.add_child("payment_reconciliation", {
			mode_of_payment: p.mode_of_payment,
			opening_amount: 0,
			expected_amount: get_base_value(p, "paid_amount", "base_paid_amount"),
		});
	}
}

function add_to_taxes(d, frm, conversion_rate) {
	d.taxes.forEach((t) => {
		const tax = frm.doc.taxes.find((tx) => tx.account_head === t.account_head && tx.rate === t.rate);
		if (tax) {
			tax.amount += flt(get_base_value(t, "tax_amount", "base_tax_amount", conversion_rate));
		} else {
			frm.add_child("taxes", {
				account_head: t.account_head,
				rate: t.rate,
				amount: get_base_value(t, "tax_amount", "base_tax_amount", conversion_rate),
			});
		}
	});
}

function reset_values(frm) {
	frm.set_value("pos_transactions", []);
	frm.set_value("payment_reconciliation", []);
	frm.set_value("pos_payments", []);
	frm.set_value("taxes", []);
	frm.set_value("grand_total", 0);
	frm.set_value("net_total", 0);
	frm.set_value("total_quantity", 0);
}

function refresh_fields(frm) {
	frm.refresh_field("pos_transactions");
	frm.refresh_field("payment_reconciliation");
	frm.refresh_field("pos_payments");
	frm.refresh_field("taxes");
	frm.refresh_field("grand_total");
	frm.refresh_field("net_total");
	frm.refresh_field("total_quantity");
}

function set_html_data(frm) {
	frappe.call({
		method: "get_payment_reconciliation_details",
		doc: frm.doc,
		callback: (r) => {
			frm.get_field("payment_reconciliation_details").$wrapper.html(r.message);
		},
	});
}

const get_value = async (doctype, name, field) => {
	if (!doctype || !name || !field) {
		return undefined;
	}

	try {
		const { message } = await frappe.db.get_value(doctype, name, field);
		return message ? message[field] : undefined;
	} catch (error) {
		console.error("Failed to fetch value:", error);
		return undefined;
	}
};

const get_cash_mode_of_payment = async (frm) => {
	const profile = frm.doc.pos_profile;

	if (!frm.__cashModeCache || frm.__cashModeCache.profile !== profile) {
		const value = await get_value("POS Profile", profile, "posa_cash_mode_of_payment");
		frm.__cashModeCache = {
			profile,
			value: value || "Cash",
		};
	}

	return frm.__cashModeCache.value;
};

const get_conversion_rate = (doc) =>
	doc.conversion_rate || doc.exchange_rate || doc.target_exchange_rate || doc.plc_conversion_rate || 1;

const get_base_value = (doc, field, base_field, conversion_rate) => {
	const base_fieldname = base_field || `base_${field}`;
	const base_value = doc[base_fieldname];
	if (base_value !== undefined && base_value !== null && base_value !== "") {
		return flt(base_value);
	}

	const value = doc[field];
	if (value === undefined || value === null || value === "") {
		return 0;
	}

	if (!conversion_rate) {
		conversion_rate =
			doc.conversion_rate ||
			doc.exchange_rate ||
			doc.target_exchange_rate ||
			doc.plc_conversion_rate ||
			1;
	}

	return flt(value) * flt(conversion_rate || 1);
};
