---
name: woocommerce
description: WooCommerce via REST (wc/v3) - orders, shipping lists, status changes with customer notes, coupons, products, collections, reports. Load before any shop task.
---
Author: Code & Blocks by Marijan

All requests through `rest_request` with path `/wc/v3/...` (Application Password of an admin or shop manager works).

## Orders

- Need shipping: `GET /wc/v3/orders?status=processing&per_page=50&orderby=date&order=asc`
- Find a customer's orders: `GET /wc/v3/orders?search=<email or name>`
- One order: `GET /wc/v3/orders/<id>` (line_items, shipping, billing, meta_data, customer_note)
- Mark shipped: `POST /wc/v3/orders/<id>` `{"status":"completed"}` – sends the "completed" email to the customer.
- Tracking number to customer: `POST /wc/v3/orders/<id>/notes` `{"note":"…","customer_note":true}` – sends an email. Show the note text first.
- Pick list: aggregate `line_items` (sku, name, quantity) over all processing orders.

## Coupons

`POST /wc/v3/coupons` `{"code":"COMEBACK-ABC123","discount_type":"percent","amount":"10","usage_limit":1,"usage_limit_per_user":1,"individual_use":true,"date_expires":"2026-12-31T23:59:59","email_restrictions":["kunde@example.de"]}`

## Products

- List: `GET /wc/v3/products?search=…&per_page=50`; categories `/wc/v3/products/categories`.
- Create (always draft first): `POST /wc/v3/products` `{"name":…,"type":"simple","status":"draft","regular_price":"19.90","description":…,"short_description":…,"categories":[{"id":…}],"images":[{"id":<media id>}]}`
- Affiliate product: `"type":"external","external_url":"…","button_text":"Kaufen bei …"`.
- Upload images with upload_media first, then reference the media id.

## Collections

A collection page = a page with the product collection / handpicked products block, or a product category/tag. Create as draft, preview, publish on approval.

## Reports

- `GET /wc/v3/reports/sales?period=week|month|last_month` (legacy totals)
- `GET /wc/v3/reports/top_sellers?period=month`
- WooCommerce Analytics: `/wc-analytics/reports/revenue/stats?interval=week&after=…&before=…`

## Settings

`GET /wc/v3/settings` → groups; `GET /wc/v3/settings/<group>`; `POST /wc/v3/settings/<group>/<id>` `{"value":…}`.

## Abandoned carts

Not part of WooCommerce core – depends on the plugin (see plugin-data skill, e.g. CartFlows table). Draft follow-up emails as text; send only through the plugin or after explicit approval.

## Comments vs. reviews

Product reviews are comments of type `review` on products. Turning off blog comments must not disable reviews unless the user wants it.
