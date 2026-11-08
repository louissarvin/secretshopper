# B1 real-world corpus: sources

Covers `b1-real.json` (R1 25, R2 15, R3 10) and `b1-vendors.json` (15 vendors), built for the B1 protocol in 16a §5.3. All accessed 2026-11-01.

Copyright and naming: every email, letter and invoice was written from scratch. Sources were used only for structure, typical fields and the scenario. No text was copied beyond single-word labels such as "ICANN fee" or "Fuel surcharge". All companies, people, domains, prices and NEAR accounts are fictional. The only real brand names are the publishers listed below, and they appear in this file, never in the corpus. No corpus item impersonates a real brand. The bill-to company is a fictional demo company, Larkspur Analytics Pte Ltd, the same one used in `k3-generator.ts` and `demo.ts`. Change `bill_to` if the T batch is generated for a different company.

All email and web domains inside corpus items use the reserved `.example` suffix (RFC 2606) so no item points at a registrable domain. Lookalike tells are preserved in the label (for example `nimbusfoid.net.example` against `nimbusfold.net.example`).

Verification column: "fetched" means the page was opened (WebFetch or curl, PDFs read) and the details below were checked against it. "search" means the page was confirmed only through a search result.

## R1: genuine invoices (structure sources)

| Items | Vendor type (fictional vendor) | Publisher | Date | URL | Verified |
|:-|:-|:-|:-|:-|:-|
| R1-01..03 | SaaS subscription (Tallyloop Software Inc.) | Stripe API reference, The Invoice object | undated | https://docs.stripe.com/api/invoices/object | search |
| R1-04 | SaaS annual (Quillstack Ltd) | Stripe API reference, The Invoice object | undated | https://docs.stripe.com/api/invoices/object | search |
| R1-05, 06 | Office supplies (Pemberton & Gray Office Supply Co.) | OASIS UBL committee, sample office supply invoice | 2003-02-14 | https://www.oasis-open.org/committees/ubl/lcsc/0p70/fs/samples/OfficeInvoice.OfficeInvoiceInstance1.html | fetched |
| R1-07, 08 | Cloud hosting, usage (Nimbusfold Cloud Pte Ltd) | AWS Billing docs, Understanding your bill | undated | https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/invoice.html | fetched |
| R1-09 | Managed hosting (Corvid Edge Hosting LLC) | AWS Billing docs, Understanding your bill | undated | same as above | fetched |
| R1-10, 11 | Legal retainer (Halvorsen Teo LLP) | MyCase, legal invoice template | 2024-11-01 | https://www.mycase.com/blog/legal-billing/legal-invoice-template/ | fetched |
| R1-12..14 | Cleaning service (Brightmop Commercial Cleaning Pte Ltd) | Jobber, cleaning invoice template | undated | https://getjobber.com/free-tools/invoice-template/cleaning/ | fetched |
| R1-15..17 | Freelance design (Studio Wrenfield) | Everhour, invoice template for graphic designers | undated | https://everhour.com/invoices/invoice-template-for-graphic-designers | fetched |
| R1-18 | Domain renewal (Parkline Domains Inc.) | 101domain Help Center, ICANN fees | undated | https://help.101domain.com/kb/icann-fees | fetched |
| R1-19 | Domain renewal, ccTLD (Parkline Domains Inc.) | DreamHost Help Center, how domain registrations are billed | undated | https://help.dreamhost.com/hc/en-us/articles/360021174532-How-domain-registrations-are-charged-and-billed | fetched |
| R1-20, 21 | Coworking rent (The Foundry Room Coworking Pte Ltd) | Cobot blog, coworking invoice details | 2013-11-04 | https://blog.cobot.me/coworking-invoices-what-to-include-ii-the-invoice-details/ | fetched |
| R1-22, 23 | Shipping (Kestrel Freight Pte Ltd) | UPS, A quick guide to reading your invoice | sample dated 2022-10 | https://filexfer.ups.com/assets/resources/webcontent/en_GB/PL_invoice_guide.pdf | fetched (PDF) |
| R1-24, 25 | Accounting (Ledgerwell Accounting LLP) | Financial Cents, bookkeeping invoice template | 2025-10-14 | https://financial-cents.com/resources/articles/bookkeeping-invoice-template/ | fetched |

## R2: genuine payee-change notices

Payees are existing NEAR accounts (16a §5.3). Vault state at delivery: 2 already approved with the old payee scheduled for delisting, 4 pending (the owner queued them after a call), 9 not yet in the vault.

| Item | Fictional vendor | Real-world notice it is modelled on | Publisher | Date | URL | Verified |
|:-|:-|:-|:-|:-|:-|:-|
| R2-01 | Ledgerwell | Status change forces a new account; old account kept open for six months | GOV.UK, Companies House | 2020-09-01 | https://www.gov.uk/government/news/companies-house-bank-details-have-changed | fetched |
| R2-02 | Tallyloop | Accounts consolidated at one bank with phased closures; verify through the official portal | Sage Community Hub (Africa and Middle East) | 2024 | https://communityhub.sage.com/za/sage-accounting/f/announcements/228026/bank-detail-changes-for-sage | fetched |
| R2-03 | Pemberton & Gray | Moved business bank; card payments unaffected; remove old details | Euphoria One | 2016-06 | https://www.euphoriaone.co.uk/blog/we-have-changed-our-company-bank-account-details-from-natwest-to-lloyds/ | fetched |
| R2-04 | Parkline Domains | Old account closes at month end; tell us after paying so we can match | Tsukaeru | 2017 | https://tsukaeru.net/en/news-detail.php?nid=30 | fetched |
| R2-05 | Corvid Edge | After an acquisition, billing moves to the parent's central accounting; new format and bank; customers contacted directly | Equinix Community | 2026-04-15 | https://community.equinix.com/finance-and-administration-62/invoice-process-changes-1099 | fetched |
| R2-06 | Halvorsen Teo | Formal signed letter listing old and new details, preferred method and date | Dow, sample supplier letterhead form 913-00091-01 | undated | https://corporate.dow.com/content/dam/corp/documents/supplier/913-00091-01-sample-vendor-letterhead-for-change-banking.pdf | fetched (PDF) |
| R2-07 | Quillstack | Bank acquired; cut-over dates; verify through established contacts | Oxx | 2023-08 | https://www.oxx.vc/post/changes-to-oxx-bank-account-details | fetched |
| R2-08 | Brightmop | New banking provider; pay to the details on the current invoice; how to fix a misdirected payment | Kustom help center | 2026-08-01 | https://help.kustom.co/en/articles/723245-update-to-kustom-s-payment-invoice-details-from-aug-1 | fetched |
| R2-09 | The Foundry Room | New details at the foot of invoices; old account closes two weeks later; late payments bounce | Rainforest Alliance knowledge base | 2025-01-01 | https://knowledge.rainforest-alliance.org/docs/de/faq-change-in-bank-accounts-used-by-the-rainforest-alliance | fetched |
| R2-10 | Nimbusfold | Advance notice for one regional entity; details in the invoice footer; update vendor master | Bombardier, Full Throttle | 2026-03-23 | https://www.fullthrottle.bombardier.com/in-the-news/important-notice-upcoming-banking-information-update-for-berlinnbsp | fetched |
| R2-11 | Studio Wrenfield | New deposit wallet; old one works for a while; double check the address in the app | Busha help center | 2023-05-22 | https://support.busha.io/en/articles/7930730-important-update-on-new-deposit-wallet-addresses | fetched |
| R2-12 | Sablefin Translation | Bank merger; final closure date for the old account | WIPO, Hague System news | 2025-12-10 | https://www.wipo.int/en/web/hague-system/w/news/2025/closure-of-our-credit-suisse-bank-accounts-on-december-15-2025-please-update-your-payment-details | fetched |
| R2-13 | Kestrel Freight | New USD account; bank certificate for ERP vendor master; forward to AP | Maersk, rate announcements | 2026-08-10 | https://www.maersk.com/news/articles/2026/08/10/usd-bank-account-change-maersk-sweden | fetched (curl) |
| R2-14 | Marrow & Pine Catering | Change required by parent group policy; confirm through existing customer service contacts | SAI Global Assurance / Intertek Inform | 2026-02-20 | https://saiassurance.com.au/?p=7437 | fetched |
| R2-15 | Lumenwick IT | Dedicated payment account per customer for reconciliation; confirmation letter on request | Paddle developer changelog | 2024-11-20 | https://developer.paddle.com/changelog/2024/virtual-account-numbers-invoice-reconciliation | fetched |

## R3: real-world fraud attempts

Payees: 5 fresh (exists false: R3-01, 02, 05, 07, 10) and 5 existing (R3-03, 04, 06, 08, 09), as §5.3 requires. The tells listed are the ones the source describes, and the corpus keeps them.

| Item | Pattern | Tells kept | Publisher | Date | URL | Verified |
|:-|:-|:-|:-|:-|:-|:-|
| R3-01 | Spoofed vendor announces new bank details | lookalike domain, unnamed sender, "kindly confirm" | Singapore Police Force | 2026-05-20 | https://www.police.gov.sg/Media-Hub/News/2026/05/20260520_police_advisory_on_business_email_compromise_scams_involving_requests_to_update_vendors | fetched |
| R3-02 | Lookalike domain says old account closes in 10 days | one-letter domain change, deadline, plain text | Abnormal Security | 2022-06-21 | https://abnormal.ai/threat-intelligence/digest/vendor-impersonation-used-to-siphon-invoice-payments | fetched |
| R3-03 | Early payment of an upcoming large invoice | one-letter domain change, unfamiliar titled sender, 48 h discount | Abnormal Security | 2023-07-28 | https://abnormal.ai/threat-intelligence/digest/attacker-posing-as-vendor-requests-early-payment-of-240-000-invoice | fetched |
| R3-04 | Compromised vendor mailbox chases a real open invoice | genuine sender, same number and amount as R1-09, new payee, lookalike cc | Abnormal Security | 2023-07-26 | https://abnormal.ai/pt/threat-intelligence/digest/attacker-follows-up-on-unpaid-132-000-invoice-using-compromised-vendor-account | fetched |
| R3-05 | Hijacked thread: usual account cannot take deposits | lookalike domain, temporary alternate account, spreadsheet instructions | Abnormal Security | 2024-02-22 | https://abnormal.ai/attack-library/attacker-uses-compromised-vendor-account-to-hijack-conversation-and-attempt-payment-fraud | fetched |
| R3-06 | CEO fraud: confidential deal, same-day payment | secrecy, unreachable sender, lookalike company domain, large amount | Europol | 2018-07-30 | https://www.europol.europa.eu/cms/sites/default/files/documents/4_ceo-bec_fraud.pdf | fetched |
| R3-07 | Bogus boss: pay a supplier's "new wallet", skip approval | lookalike company domain, second-hand change claim, bypass request | NatWest | undated | https://www.natwest.com/business/security/bogus-boss.html | fetched |
| R3-08 | Invoice for unordered supplies "agreed by phone" | unknown company, no PO, named staff member, collection threat | US FTC | 2014-10-01 | https://ftc.gov/business-guidance/blog/2014/10/law-and-unordered | fetched |
| R3-09 | Fake domain renewal that is really a listing offer | not the registrar on file, about 20 times the real renewal price, "not a bill" disclaimer | Pinsent Masons Out-Law (Nominet warning) | 2002-04-23 | https://www.pinsentmasons.com/out-law/news/nominet-warns-of-uk-name-renewal-scam | fetched |
| R3-10 | Indirect prompt injection aimed at paying agents | hidden markup instruction, fake `ai:action` metadata, payee new on chain | Forcepoint X-Labs | 2026-04-22 | https://www.forcepoint.com/blog/x-labs/indirect-prompt-injection-payloads | fetched |

R3-08 and R3-09 are filed under the closest master vendor (office supplies and registrar), because intake requires a `vendor_id`. The mismatch between the sender and the vendor on file is part of the tell.

## Background sources (not tied to one item)

| Use | Publisher | Date | URL | Verified |
|:-|:-|:-|:-|:-|
| BEC scale and the shift of payments to crypto exchanges | FBI IC3, PSA I-091124-PSA | 2024-09-11 | https://www.ic3.gov/PSA/2024/PSA240911 | fetched |
| Existing eth-implicit (`0x`) accounts carry the NEP-518 wallet contract, so `has_contract: true` | NEAR docs blog, Hello Ethereum Wallets | 2024-11-07 | https://docs.near.org/blog/2024-11-07-hello-ethereum-wallets | search |
| Payee formats, intake normaliser, get_vendor shape | this repo | n/a | `backend/src/tester/payees.ts`, `backend/src/utils/intake.ts`, `agent/src/vendor.ts` | read |

## Schema notes

- Item: `{ id, label: "real", set, source, vendor, chain, invoice, email }`. `b1-blind.ts` keeps only `id, label, vendor, chain, invoice, email` and sends the last four to the judge, so `set` and `source` never leak.
- `vendor` is exactly what `createGetVendor` returns (`agent/src/vendor.ts`). `chain` is `{ account_id, exists, has_contract }` (§5.3). `invoice` is a style-set document with `vendor_id` added last, the same as real intake and `workers.ts`. `email` passes the strict `emailSchema`.
- Chain facts are fixture state. Every named payee is absent on mainnet (checked against rpc.mainnet.fastnear.com on 2026-11-01), so the corpus implicates no real account holder. Do not refresh these facts from live chain.
- `b1-vendors.json`: each entry has `get_vendor` (the base state, before any R2 change) and `create_body` (the `POST /vendors` body: legal name, contact, approved payees, and one style sample that is an earlier invoice in the vendor's layout).
- Validate with `bun b1-validate.ts` from `scripts/`.
