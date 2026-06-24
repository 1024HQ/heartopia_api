const state = {
  meta: null,
  groups: [],
  selectedProduct: null,
  selectedChannel: null,
  selectedChannelKey: null,
  result: null
};

const els = {
  form: document.getElementById("queryForm"),
  userId: document.getElementById("userId"),
  roleId: document.getElementById("roleId"),
  serverId: document.getElementById("serverId"),
  region: document.getElementById("region"),
  customRegionEnabled: document.getElementById("customRegionEnabled"),
  regionCustom: document.getElementById("regionCustom"),
  productGroups: document.getElementById("productGroups"),
  productStatus: document.getElementById("productStatus"),
  channels: document.getElementById("channels"),
  channelStatus: document.getElementById("channelStatus"),
  flatChannels: document.getElementById("flatChannels"),
  quantity: document.getElementById("quantity"),
  createBtn: document.getElementById("createBtn"),
  resetBtn: document.getElementById("resetBtn"),
  payUrl: document.getElementById("payUrl"),
  copyBtn: document.getElementById("copyBtn"),
  resultDetails: document.getElementById("resultDetails"),
  rawResult: document.getElementById("rawResult"),
  toast: document.getElementById("toast")
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2400);
}

function money(channelOrProduct) {
  if (!channelOrProduct) return "-";
  if (channelOrProduct.displaySalePrice) return channelOrProduct.displaySalePrice;
  if (channelOrProduct.salePrice !== undefined && channelOrProduct.currency) {
    return `${channelOrProduct.salePrice} ${channelOrProduct.currency}`;
  }
  return "-";
}

function oldMoney(item) {
  if (!item || item.costPrice === item.salePrice) return "";
  return item.displayCostPrice || `${item.costPrice} ${item.currency || ""}`.trim();
}

function channelErrorMessage(error) {
  if (!error) return "";
  let parsed = error;
  if (typeof error === "string") {
    try {
      parsed = JSON.parse(error);
    } catch {
      return error;
    }
  }
  if (parsed?.msg) return parsed.msg;
  if (parsed?.detail) return parsed.detail;
  if (parsed?.error) return channelErrorMessage(parsed.error);
  return String(error);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getFormData() {
  const customRegion = els.customRegionEnabled.checked ? els.regionCustom.value.trim() : "";
  return {
    appId: "2085001",
    userId: els.userId.value.trim(),
    roleId: els.roleId.value.trim(),
    serverId: els.serverId.value,
    region: (customRegion || els.region.value).toUpperCase()
  };
}

function syncCustomRegionMode() {
  const enabled = els.customRegionEnabled.checked;
  els.regionCustom.disabled = !enabled;
  els.regionCustom.classList.toggle("hidden-input", !enabled);
  els.region.parentElement.classList.toggle("custom-disabled", !enabled);
  if (enabled) els.regionCustom.focus();
}

function showLoading() {
  els.productGroups.className = "product-area";
  els.productGroups.innerHTML = `
    <div class="product-grid">
      ${Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join("")}
    </div>
  `;
  els.productStatus.textContent = "กำลังดึงสินค้าและช่องทางจ่าย...";
  els.channels.className = "channel-area empty-state";
  els.channels.textContent = "เลือก Product หลังโหลดเสร็จ";
  els.channelStatus.textContent = "รอเลือก Product";
}

function renderProducts() {
  const groups = state.groups || [];
  const total = groups.reduce((sum, group) => sum + (group.products || []).length, 0);
  els.productStatus.textContent = total ? `พบ ${total} รายการ` : "ไม่พบสินค้า";

  if (!total) {
    els.productGroups.className = "product-area empty-state";
    els.productGroups.textContent = "ไม่พบรายการสินค้า";
    return;
  }

  els.productGroups.className = "product-area";
  els.productGroups.innerHTML = groups
    .map((group) => {
      const cards = (group.products || [])
        .map((product) => {
          const channels = product.channels || [];
          const paymentNames = [...new Set(channels.map((c) => c.subChannelName || c.paymentGroup).filter(Boolean))].slice(0, 4);
          const errorMsg = channelErrorMessage(product.channelError);
          const error = errorMsg ? `<p class="error-text">${escapeHtml(errorMsg)}</p>` : "";
          return `
            <button class="product-card" type="button" data-sku="${product.productSkuCode}">
              <img class="product-img" src="${product.icon || ""}" alt="" loading="lazy" />
              <p class="name">${product.productSkuName || product.desc || product.productSkuCode}</p>
              <p class="sku">${product.productSkuCode}</p>
              <div class="price">
                <span>${money(product)}</span>
                ${oldMoney(product) ? `<span class="old-price">${oldMoney(product)}</span>` : ""}
              </div>
              <p class="meta">${channels.length} ช่องทางชำระเงิน</p>
              <div class="chips">${paymentNames.map((name) => `<span class="chip">${name}</span>`).join("")}</div>
              ${error}
            </button>
          `;
        })
        .join("");

      return `
        <div class="product-group">
          <h3 class="group-title">${group.productName || "Product"} <span>${group.productType || ""}</span></h3>
          <div class="product-grid">${cards}</div>
        </div>
      `;
    })
    .join("");

  document.querySelectorAll(".product-card").forEach((card) => {
    card.addEventListener("click", () => selectProduct(card.dataset.sku));
  });
}

function findProduct(sku) {
  for (const group of state.groups) {
    const product = (group.products || []).find((item) => item.productSkuCode === sku);
    if (product) return product;
  }
  return null;
}

function selectProduct(sku) {
  state.selectedProduct = findProduct(sku);
  state.selectedChannel = null;
  state.selectedChannelKey = null;
  state.result = null;
  renderProductsActive();
  renderChannels();
  clearResult();
}

function renderProductsActive() {
  document.querySelectorAll(".product-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.sku === state.selectedProduct?.productSkuCode);
  });
}

function renderChannels() {
  const product = state.selectedProduct;
  els.createBtn.disabled = true;

  if (!product) {
    els.channels.className = "channel-area empty-state";
    els.channels.textContent = "ยังไม่ได้เลือกสินค้า";
    els.channelStatus.textContent = "เลือก Product ก่อน";
    return;
  }

  const groups = product.channelGroups || [];
  const total = (product.channels || []).length;
  els.channelStatus.textContent = `${product.productSkuName} / ${total} ช่องทาง`;

  if (!total) {
    els.channels.className = "channel-area empty-state";
    const errorMsg = channelErrorMessage(product.channelError);
    els.channels.textContent = errorMsg ? `ดึงช่องทางไม่สำเร็จ: ${errorMsg}` : "SKU นี้ไม่มีช่องทางจ่าย";
    return;
  }

  els.channels.className = "channel-area";
  if (els.flatChannels.checked) {
    const cards = groups
      .flatMap((group) => (group.channels || []).map((channel, index) => renderChannelCard(group, channel, index)))
      .join("");
    els.channels.innerHTML = `<div class="channel-grid flat-channel-grid">${cards}</div>`;
  } else {
    els.channels.innerHTML = groups
      .map((group) => {
        const cards = (group.channels || []).map((channel, index) => renderChannelCard(group, channel, index)).join("");
        return `
          <div class="channel-group">
            <h3 class="group-title">${group.type || "Payment"} <span>${(group.channels || []).length} ช่องทาง</span></h3>
            <div class="channel-grid">${cards}</div>
          </div>
        `;
      })
      .join("");
  }

  document.querySelectorAll(".channel-card").forEach((card) => {
    card.addEventListener("click", () => selectChannel(card.dataset.key));
    card.classList.toggle("active", card.dataset.key === state.selectedChannelKey);
  });
  els.createBtn.disabled = !state.selectedChannel;
}

function renderChannelCard(group, channel, index) {
  const key = `${group.type}::${channel.subChannelCode}::${index}`;
  return `
    <button class="channel-card" type="button" data-key="${key}">
      <img class="channel-logo" src="${channel.logoUrl || ""}" alt="" loading="lazy" />
      <p class="name">${channel.subChannelName || channel.subChannelCode}</p>
      <p class="sku">${channel.subChannelCode} · channelType ${channel.channelType}</p>
      <div class="price">
        <span>${money(channel)}</span>
        ${oldMoney(channel) ? `<span class="old-price">${oldMoney(channel)}</span>` : ""}
      </div>
      <p class="meta">${channel.currency || ""} · ${channel.region || ""}</p>
      ${channel.promotionDesc ? `<p class="meta promo-desc">${channel.promotionDesc}</p>` : ""}
    </button>
  `;
}

function selectChannel(key) {
  const product = state.selectedProduct;
  let selected = null;

  for (const group of product.channelGroups || []) {
    for (const [index, channel] of (group.channels || []).entries()) {
      const currentKey = `${group.type}::${channel.subChannelCode}::${index}`;
      if (currentKey === key) {
        selected = { ...channel, paymentGroup: group.type };
      }
    }
  }

  state.selectedChannel = selected;
  state.selectedChannelKey = selected ? key : null;
  document.querySelectorAll(".channel-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.key === key);
  });
  els.createBtn.disabled = !selected;
  clearResult();
}

function unwrapOrderData(response) {
  const data = response?.data;
  if (data?.data?.data) return data.data.data;
  if (data?.data) return data.data;
  return data || {};
}

function renderResult(response) {
  state.result = response;
  const order = unwrapOrderData(response);
  els.payUrl.value = order.payUrl || "";
  els.copyBtn.disabled = !order.payUrl;

  const fields = [
    "trxNo",
    "tradeNo",
    "outTradeNo",
    "requestTime",
    "timeExpire",
    "currency",
    "totalAmount",
    "payUrl",
    "paymentChannel",
    "quantity"
  ];

  els.resultDetails.innerHTML = fields
    .map((field) => {
      const value = order[field] ?? "-";
      return `<div class="detail-item"><strong>${field}</strong><span>${value}</span></div>`;
    })
    .join("");

  els.rawResult.textContent = JSON.stringify(response, null, 2);
  els.rawResult.classList.add("has-content");
}

function clearResult() {
  els.payUrl.value = "";
  els.copyBtn.disabled = true;
  els.resultDetails.innerHTML = "";
  els.rawResult.textContent = "";
  els.rawResult.classList.remove("has-content");
}

async function loadProducts(event) {
  event.preventDefault();
  state.groups = [];
  state.selectedProduct = null;
  state.selectedChannel = null;
  state.selectedChannelKey = null;
  state.result = null;
  clearResult();
  showLoading();

  const params = new URLSearchParams(getFormData());

  try {
    const res = await fetch(`/api/products?${params.toString()}`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(JSON.stringify(json.error || json));
    state.meta = json.meta;
    state.groups = json.data || [];
    renderProducts();
    toast("โหลดสินค้าเรียบร้อย");
  } catch (err) {
    els.productGroups.className = "product-area empty-state";
    els.productGroups.textContent = `โหลดไม่สำเร็จ: ${err.message}`;
    els.productStatus.textContent = "ผิดพลาด";
    toast("โหลดสินค้าไม่สำเร็จ");
  }
}

async function createPaylink() {
  const product = state.selectedProduct;
  const channel = state.selectedChannel;
  if (!product || !channel) {
    toast("เลือกสินค้าและช่องทางชำระก่อน");
    return;
  }

  els.createBtn.disabled = true;
  els.createBtn.textContent = "กำลังสร้างบิล...";

  try {
    const res = await fetch("/api/create-paylink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...getFormData(),
        productSkuCode: product.productSkuCode,
        quantity: els.quantity.value,
        channelType: channel.channelType,
        subChannelCode: channel.subChannelCode,
        currency: channel.currency,
        promotionId: channel.promotionId
      })
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(JSON.stringify(json.error || json));
    renderResult(json);
    toast("สร้าง Paylink สำเร็จ");
  } catch (err) {
    clearResult();
    els.rawResult.textContent = err.message;
    els.rawResult.classList.add("has-content");
    toast("สร้างบิลไม่สำเร็จ");
  } finally {
    els.createBtn.disabled = !state.selectedChannel;
    els.createBtn.textContent = "สร้างบิลชำระ";
  }
}

function resetAll() {
  state.meta = null;
  state.groups = [];
  state.selectedProduct = null;
  state.selectedChannel = null;
  state.selectedChannelKey = null;
  state.result = null;
  els.productGroups.className = "product-area empty-state";
  els.productGroups.textContent = "ยังไม่มีรายการสินค้า";
  els.productStatus.textContent = "รอกรอกข้อมูล";
  els.channels.className = "channel-area empty-state";
  els.channels.textContent = "ยังไม่ได้เลือกสินค้า";
  els.channelStatus.textContent = "เลือก Product ก่อน";
  els.createBtn.disabled = true;
  clearResult();
}

els.form.addEventListener("submit", loadProducts);
els.createBtn.addEventListener("click", createPaylink);
els.resetBtn.addEventListener("click", resetAll);
els.customRegionEnabled.addEventListener("change", syncCustomRegionMode);
els.flatChannels.addEventListener("change", renderChannels);
els.copyBtn.addEventListener("click", async () => {
  if (!els.payUrl.value) return;
  await navigator.clipboard.writeText(els.payUrl.value);
  toast("Copy Paylink แล้ว");
});

syncCustomRegionMode();
