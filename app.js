const STORAGE_KEY = "plannerMapDataV1";
const NODE_WIDTH_RANGE = [170, 240];
const NODE_HEIGHT_RANGE = [120, 190];
const NODE_RADIUS_RANGE = [
  Math.min(NODE_WIDTH_RANGE[0], NODE_HEIGHT_RANGE[0]) / 2,
  Math.max(NODE_WIDTH_RANGE[1], NODE_HEIGHT_RANGE[1]) / 2,
];
const ROOT_NODE_RADIUS = NODE_RADIUS_RANGE[1] * 3;
const ESTIMATED_RATE = 100;

const mapViewport = document.getElementById("map-viewport");
const mapContent = document.getElementById("map-content");
const linksLayer = document.getElementById("links-layer");
const nodeForm = document.getElementById("node-form");
const connectionsList = document.getElementById("connections-list");
const addRootButton = document.getElementById("add-root");
const addChildButton = document.getElementById("add-child");
const deleteNodeButton = document.getElementById("delete-node");
const linkNodeButton = document.getElementById("link-node");
const fitViewButton = document.getElementById("fit-view");
const resetViewButton = document.getElementById("reset-view");
const linkModal = document.getElementById("link-modal");
const linkDependentSelect = document.getElementById("link-dependent");
const linkRequiredSelect = document.getElementById("link-required");
const confirmLinkButton = document.getElementById("confirm-link");
const cancelLinkButton = document.getElementById("cancel-link");
const sidebarToggleButton = document.getElementById("sidebar-toggle");
const sidebarOpenButton = document.getElementById("sidebar-open");
const appContainer = document.querySelector(".app");

let state = loadState();
let selectedNodeId = state.nodes[0]?.id ?? null;
let viewState = {
  x: 0,
  y: 0,
  scale: 1,
};
let isDragging = false;
let isNodeDragging = false;
let draggedNodeId = null;
let dragOffset = { x: 0, y: 0 };
let didDragNode = false;
let dragStart = { x: 0, y: 0 };
let dragOrigin = { x: 0, y: 0 };
let draggedSubtreeIds = new Set();
let dragStartPositions = new Map();
let layoutCache = {
  positions: new Map(),
  animationFrameId: null,
};

const STATUS_OPTIONS = [
  "Considering",
  "Shelved",
  "Committed",
  "In Progress",
  "Complete",
];

const STATUS_CLASS_MAP = new Map(
  STATUS_OPTIONS.map((status) => [
    status,
    `node--status-${status.toLowerCase().replace(/\s+/g, "-")}`,
  ])
);
const STATUS_CLASS_NAMES = Array.from(STATUS_CLASS_MAP.values());
const ASSIGNEE_CLASS_MAP = new Map([
  ["Trey", "node--trey"],
  ["Sarah", "node--sarah"],
  ["Both", "node--both"],
]);
const ASSIGNEE_CLASS_NAMES = Array.from(ASSIGNEE_CLASS_MAP.values());

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (error) {
      console.warn("Failed to parse saved data", error);
    }
  }

  return {
    nodes: [
      {
        id: crypto.randomUUID(),
        name: "Dream Cabin Getaway",
        description: "Cozy weekend space for family and friends.",
        estimatedCost: 12000,
        estimatedTime: 80,
        status: "Considering",
        assignedTo: "",
      },
      {
        id: crypto.randomUUID(),
        name: "Permits & Paperwork",
        description: "Local approvals and inspections.",
        estimatedCost: 800,
        estimatedTime: 12,
        status: "Committed",
        assignedTo: "Sarah",
      },
      {
        id: crypto.randomUUID(),
        name: "Design Layout",
        description: "Blueprint and floor planning.",
        estimatedCost: 1500,
        estimatedTime: 25,
        status: "In Progress",
        assignedTo: "Trey",
      },
    ],
    links: [],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function buildGraph() {
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const childrenMap = new Map();
  const incomingMap = new Map();

  state.links.forEach((link) => {
    if (!childrenMap.has(link.from)) {
      childrenMap.set(link.from, []);
    }
    childrenMap.get(link.from).push(link.to);

    if (!incomingMap.has(link.to)) {
      incomingMap.set(link.to, []);
    }
    incomingMap.get(link.to).push(link.from);
  });

  return { nodesById, childrenMap, incomingMap };
}

function collectDescendants(rootId, childrenMap) {
  const visited = new Set();
  const queue = [rootId];
  while (queue.length) {
    const currentId = queue.shift();
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    (childrenMap.get(currentId) || []).forEach((childId) => {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    });
  }
  return visited;
}

function getRootId(incomingMap) {
  const roots = state.nodes.filter(
    (node) => !(incomingMap.get(node.id) || []).length
  );
  return roots[0]?.id ?? state.nodes[0]?.id ?? null;
}

function computeTotals() {
  const { nodesById, childrenMap } = buildGraph();
  const memo = new Map();

  function totalFor(nodeId, trail = new Set()) {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }
    const node = nodesById.get(nodeId);
    if (!node || node.status === "Shelved") {
      const totals = { cost: 0, time: 0 };
      memo.set(nodeId, totals);
      return totals;
    }
    if (trail.has(nodeId)) {
      return { cost: 0, time: 0 };
    }
    const nextTrail = new Set(trail);
    nextTrail.add(nodeId);

    let cost = node.estimatedCost;
    let time = node.estimatedTime;

    (childrenMap.get(nodeId) || []).forEach((childId) => {
      const childTotals = totalFor(childId, nextTrail);
      cost += childTotals.cost;
      time += childTotals.time;
    });

    const totals = { cost, time };
    memo.set(nodeId, totals);
    return totals;
  }

  const totalsById = new Map();
  state.nodes.forEach((node) => {
    totalsById.set(node.id, totalFor(node.id));
  });
  return totalsById;
}

function computeLayout(nodeSizes) {
  const { childrenMap, incomingMap, nodesById } = buildGraph();
  const positions = layoutCache.positions;
  const viewportRect = mapViewport.getBoundingClientRect();
  const centerX = viewportRect.width / 2;
  const centerY = viewportRect.height / 2;
  const nodeCount = Math.max(state.nodes.length, 1);

  const existingIds = new Set(state.nodes.map((node) => node.id));
  layoutCache.positions.forEach((_, id) => {
    if (!existingIds.has(id)) {
      layoutCache.positions.delete(id);
    }
  });

  state.nodes.forEach((node, index) => {
    let position = positions.get(node.id);
    if (node.positionLocked && node.position) {
      position = { ...node.position };
      positions.set(node.id, position);
      return;
    }
    if (!position) {
      const angle = (index / nodeCount) * Math.PI * 2;
      const radius = 180 + (index % 5) * 20;
      position = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      };
      positions.set(node.id, position);
    }
  });

  const rootId = getRootId(incomingMap);
  if (rootId) {
    const rootNode = nodesById.get(rootId);
    if (rootNode && !rootNode.positionLocked) {
      positions.set(rootId, { x: centerX, y: centerY });
    }
  }

  const roots = state.nodes.filter(
    (node) => !(incomingMap.get(node.id) || []).length
  );
  const extraRoots = roots.filter((node) => node.id !== rootId);
  if (rootId && extraRoots.length > 0) {
    const rootPosition = positions.get(rootId) || { x: centerX, y: centerY };
    const rootRadius = nodeSizes.get(rootId)?.radius || ROOT_NODE_RADIUS;
    const extraRadius = rootRadius * 2.2;
    const angleStep = (Math.PI * 2) / extraRoots.length;
    extraRoots.forEach((node, index) => {
      if (node.positionLocked) {
        return;
      }
      const angle = -Math.PI / 2 + angleStep * index;
      positions.set(node.id, {
        x: rootPosition.x + Math.cos(angle) * extraRadius,
        y: rootPosition.y + Math.sin(angle) * extraRadius,
      });
    });
  }

  const queue = rootId ? [rootId] : [];
  const seen = new Set(queue);
  if (!rootId) {
    roots.forEach((node) => {
      queue.push(node.id);
      seen.add(node.id);
    });
  }

  while (queue.length > 0) {
    const parentId = queue.shift();
    const parentPos = positions.get(parentId);
    if (!parentPos) {
      continue;
    }
    const children = childrenMap.get(parentId) || [];
    const autoChildren = children.filter(
      (childId) => !nodesById.get(childId)?.positionLocked
    );
    if (autoChildren.length > 0) {
      const parentRadius = nodeSizes.get(parentId)?.radius || ROOT_NODE_RADIUS;
      const childRadii = autoChildren.map(
        (childId) => nodeSizes.get(childId)?.radius || parentRadius * 0.5
      );
      const maxChildRadius = Math.max(...childRadii, 0);
      const distance = parentRadius + maxChildRadius + 90;
      const angleStep = (Math.PI * 2) / autoChildren.length;
      autoChildren.forEach((childId, index) => {
        const angle = -Math.PI / 2 + angleStep * index;
        positions.set(childId, {
          x: parentPos.x + Math.cos(angle) * distance,
          y: parentPos.y + Math.sin(angle) * distance,
        });
      });
    }

    children.forEach((childId) => {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    });
  }

  return positions;
}

function buildLinkPath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  const curveThreshold = 140;
  let path = `M ${x1} ${y1} L ${x2} ${y2}`;

  if (distance > curveThreshold) {
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const curveIntensity = Math.min(distance / 3, 140);
    const normX = distance === 0 ? 0 : -dy / distance;
    const normY = distance === 0 ? 0 : dx / distance;
    const controlX = midX + normX * curveIntensity;
    const controlY = midY + normY * curveIntensity;
    path = `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
  }

  return path;
}

function updateLinkPositions(nodeElements, linkElements) {
  linkElements.forEach((link) => {
    const fromNode = nodeElements.get(link.from);
    const toNode = nodeElements.get(link.to);
    if (!fromNode || !toNode) {
      return;
    }
    const x1 = fromNode.position.x;
    const y1 = fromNode.position.y;
    const x2 = toNode.position.x;
    const y2 = toNode.position.y;
    const path = buildLinkPath(x1, y1, x2, y2);

    link.path.setAttribute("d", path);
    link.arrow.setAttribute("cx", x2);
    link.arrow.setAttribute("cy", y2);
  });
}

function startLayoutAnimation(nodeSizes, nodeElements, linkElements) {
  if (layoutCache.animationFrameId) {
    cancelAnimationFrame(layoutCache.animationFrameId);
  }

  const positions = computeLayout(nodeSizes);
  nodeElements.forEach((node, id) => {
    const position = positions.get(id);
    if (!position) {
      return;
    }
    node.position = position;
    node.element.style.left = `${position.x}px`;
    node.element.style.top = `${position.y}px`;
  });
  updateLinkPositions(nodeElements, linkElements);
}

function collectShelvedBranchIds() {
  const { childrenMap } = buildGraph();
  const shelvedBranchIds = new Set();
  const queue = state.nodes
    .filter((node) => node.status === "Shelved")
    .map((node) => node.id);

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (shelvedBranchIds.has(nodeId)) {
      continue;
    }
    shelvedBranchIds.add(nodeId);
    (childrenMap.get(nodeId) || []).forEach((childId) => {
      if (!shelvedBranchIds.has(childId)) {
        queue.push(childId);
      }
    });
  }

  return shelvedBranchIds;
}

function formatMetaLine({ time, cost, prefix = "", isStrong = false }) {
  const parts = [];
  if (time > 0) {
    parts.push(`${time}h`);
  }
  if (cost > 0) {
    parts.push(`$${cost.toLocaleString()}`);
  }
  if (parts.length === 0) {
    return "";
  }
  const className = isStrong ? "node__meta-line node__meta-line--strong" : "node__meta-line";
  return `<div class="${className}">${prefix}${parts.join(" and ")}</div>`;
}

function fitNodeText(nodeEl, radius) {
  if (!nodeEl) {
    return;
  }
  const content = nodeEl.querySelector(".node__content");
  if (!content) {
    return;
  }
  const baseFontSize = Math.max(11, Math.min(radius * 0.24, 38));
  const minFontSize = 10;
  let fontSize = baseFontSize;

  const fits = () =>
    content.scrollHeight <= nodeEl.clientHeight &&
    content.scrollWidth <= nodeEl.clientWidth;

  nodeEl.style.setProperty("--node-font-size", `${fontSize}px`);
  if (fits()) {
    return;
  }

  let attempts = 0;
  while (!fits() && fontSize > minFontSize && attempts < 14) {
    fontSize = Math.max(minFontSize, fontSize * 0.9);
    nodeEl.style.setProperty("--node-font-size", `${fontSize}px`);
    attempts += 1;
  }
}

function render() {
  mapContent.innerHTML = "";
  linksLayer.innerHTML = "";

  const totalsById = computeTotals();
  const shelvedBranchIds = collectShelvedBranchIds();
  const { childrenMap, incomingMap } = buildGraph();
  const nodeSizes = new Map();
  const rootId = getRootId(incomingMap);

  if (rootId) {
    nodeSizes.set(rootId, {
      radius: ROOT_NODE_RADIUS,
      width: ROOT_NODE_RADIUS * 2,
      height: ROOT_NODE_RADIUS * 2,
    });
  }

  const estimateFor = (nodeId) => {
    const totals = totalsById.get(nodeId) || { cost: 0, time: 0 };
    return totals.cost + totals.time * ESTIMATED_RATE;
  };

  const applySiblingSizing = (parentId, childIds) => {
    if (!childIds.length) {
      return;
    }
    const parentRadius =
      nodeSizes.get(parentId)?.radius || ROOT_NODE_RADIUS;
    const maxChildRadius = parentRadius * 0.75;
    const minChildRadius = Math.max(parentRadius * 0.35, 36);
    const values = childIds.map((childId) => estimateFor(childId));
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);

    childIds.forEach((childId, index) => {
      let scaleValue = 0.5;
      if (maxValue !== minValue) {
        scaleValue = (values[index] - minValue) / (maxValue - minValue);
      } else if (childIds.length === 1) {
        scaleValue = 1;
      }
      const radius =
        minChildRadius + (maxChildRadius - minChildRadius) * scaleValue;
      nodeSizes.set(childId, {
        radius,
        width: radius * 2,
        height: radius * 2,
      });
    });
  };

  const queue = rootId ? [rootId] : [];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parentId = queue.shift();
    const children = childrenMap.get(parentId) || [];
    applySiblingSizing(parentId, children);
    children.forEach((childId) => {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    });
  }

  const roots = state.nodes.filter(
    (node) => !(incomingMap.get(node.id) || []).length
  );
  const extraRoots = roots.filter((node) => node.id !== rootId);
  if (extraRoots.length > 0) {
    applySiblingSizing(rootId || extraRoots[0].id, extraRoots.map((n) => n.id));
  }

  state.nodes.forEach((node) => {
    if (!nodeSizes.has(node.id)) {
      const radius = ROOT_NODE_RADIUS * 0.55;
      nodeSizes.set(node.id, {
        radius,
        width: radius * 2,
        height: radius * 2,
      });
    }
  });

  const positions = computeLayout(nodeSizes);
  const nodeElements = new Map();
  const linkElements = [];

  state.nodes.forEach((node) => {
    const totals = totalsById.get(node.id) || { cost: 0, time: 0 };
    const position = positions.get(node.id) || { x: 0, y: 0 };
    const { width, height, radius } = nodeSizes.get(node.id);

    const nodeEl = document.createElement("div");
    nodeEl.className = "node";
    if (node.status === "Shelved") {
      nodeEl.classList.add("node--shelved");
    }
    const statusClass = STATUS_CLASS_MAP.get(node.status);
    if (statusClass) {
      nodeEl.classList.add(statusClass);
    }
    if (shelvedBranchIds.has(node.id)) {
      nodeEl.classList.add("node--dimmed");
    }
    const assigneeClass = ASSIGNEE_CLASS_MAP.get(node.assignedTo);
    if (assigneeClass) {
      nodeEl.classList.add(assigneeClass);
    }
    if (node.id === selectedNodeId) {
      nodeEl.classList.add("node--selected");
    }
    nodeEl.style.width = `${width}px`;
    nodeEl.style.height = `${height}px`;
    nodeEl.style.left = `${position.x}px`;
    nodeEl.style.top = `${position.y}px`;
    nodeEl.style.transform = "translate(-50%, -50%)";
    nodeEl.dataset.nodeId = node.id;

    const totalCost = totals.cost;
    const totalTime = totals.time;
    const estimateLine = formatMetaLine({
      time: node.estimatedTime,
      cost: node.estimatedCost,
      isStrong: true,
    });
    const totalLine = formatMetaLine({
      time: totalTime,
      cost: totalCost,
      prefix: "Total: ",
    });

    nodeEl.innerHTML = `
      <div class="node__content">
        <div class="node__title">${node.name}</div>
        <div class="node__meta">
          ${estimateLine}
          ${totalLine}
        </div>
      </div>
    `;

    nodeEl.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.stopPropagation();
      selectedNodeId = node.id;
      updateForm();
      updateConnections();
      isNodeDragging = true;
      draggedNodeId = node.id;
      didDragNode = false;
      const rect = mapViewport.getBoundingClientRect();
      const mapX = (event.clientX - rect.left - viewState.x) / viewState.scale;
      const mapY = (event.clientY - rect.top - viewState.y) / viewState.scale;
      dragOffset = {
        x: position.x - mapX,
        y: position.y - mapY,
      };
      const { childrenMap, nodesById } = buildGraph();
      draggedSubtreeIds = collectDescendants(node.id, childrenMap);
      dragStartPositions = new Map();
      draggedSubtreeIds.forEach((nodeId) => {
        const cachedPosition = layoutCache.positions.get(nodeId);
        const fallbackPosition = nodesById.get(nodeId)?.position;
        const startPosition = cachedPosition || fallbackPosition;
        if (startPosition) {
          dragStartPositions.set(nodeId, { ...startPosition });
        }
      });
      if (!dragStartPositions.has(node.id)) {
        dragStartPositions.set(node.id, { ...position });
      }
    });

    nodeEl.addEventListener("click", (event) => {
      if (didDragNode) {
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      selectedNodeId = node.id;
      setSidebarCollapsed(false);
      updateForm();
      render();
    });

    mapContent.appendChild(nodeEl);
    fitNodeText(nodeEl, radius);
    nodeElements.set(node.id, { element: nodeEl, position, width, height });
  });

  state.links.forEach((link) => {
    const fromNode = nodeElements.get(link.from);
    const toNode = nodeElements.get(link.to);
    if (!fromNode || !toNode) {
      return;
    }
    const line = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    const x1 = fromNode.position.x;
    const y1 = fromNode.position.y;
    const x2 = toNode.position.x;
    const y2 = toNode.position.y;
    const path = buildLinkPath(x1, y1, x2, y2);

    line.setAttribute("d", path);
    line.setAttribute("stroke", "#9aa3b2");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("fill", "none");
    if (shelvedBranchIds.has(link.from) || shelvedBranchIds.has(link.to)) {
      line.classList.add("link--dimmed");
    }
    linksLayer.appendChild(line);

    const arrow = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle"
    );
    arrow.setAttribute("cx", x2);
    arrow.setAttribute("cy", y2);
    arrow.setAttribute("r", "4");
    arrow.setAttribute("fill", "#4b8cff");
    if (shelvedBranchIds.has(link.from) || shelvedBranchIds.has(link.to)) {
      arrow.classList.add("link--dimmed");
    }
    linksLayer.appendChild(arrow);

    linkElements.push({
      from: link.from,
      to: link.to,
      path: line,
      arrow,
    });
  });

  updateForm();
  updateConnections();
  updateLinksBounds();
  startLayoutAnimation(nodeSizes, nodeElements, linkElements);
}

function updateLinksBounds() {
  const rect = mapViewport.getBoundingClientRect();
  linksLayer.setAttribute("width", rect.width);
  linksLayer.setAttribute("height", rect.height);
}

function syncFormToState({ shouldRender = false } = {}) {
  const selected = state.nodes.find((node) => node.id === selectedNodeId);
  if (!selected) {
    return;
  }

  const formData = new FormData(nodeForm);
  selected.name = formData.get("name").toString();
  selected.description = formData.get("description").toString();
  selected.estimatedCost = Number(formData.get("estimatedCost")) || 0;
  selected.estimatedTime = Number(formData.get("estimatedTime")) || 0;
  selected.status = formData.get("status").toString();
  selected.assignedTo = formData.get("assignedTo").toString();

  saveState();

  if (shouldRender) {
    render();
  } else {
    updateSelectedNodeDisplay(selected);
  }
}

function setSidebarCollapsed(isCollapsed) {
  appContainer.classList.toggle("app--sidebar-collapsed", isCollapsed);
}

function updateForm() {
  const selected = state.nodes.find((node) => node.id === selectedNodeId);
  const formElements = nodeForm.elements;

  if (!selected) {
    nodeForm.reset();
    Array.from(formElements).forEach((element) => {
      element.disabled = true;
    });
    return;
  }

  Array.from(formElements).forEach((element) => {
    element.disabled = false;
  });

  formElements.name.value = selected.name;
  formElements.description.value = selected.description;
  formElements.estimatedCost.value = selected.estimatedCost;
  formElements.estimatedTime.value = selected.estimatedTime;
  formElements.status.value = selected.status;
  formElements.assignedTo.value = selected.assignedTo;
}

function updateSelectedNodeDisplay(selected) {
  const nodeEl = mapContent.querySelector(
    `[data-node-id="${selected.id}"]`
  );
  if (!nodeEl) {
    return;
  }

  const titleEl = nodeEl.querySelector(".node__title");
  if (titleEl) {
    titleEl.textContent = selected.name;
  }

  const metaEl = nodeEl.querySelector(".node__meta");
  if (metaEl) {
    const totalsById = computeTotals();
    const totals = totalsById.get(selected.id) || { cost: 0, time: 0 };
    const estimateLine = formatMetaLine({
      time: selected.estimatedTime,
      cost: selected.estimatedCost,
      isStrong: true,
    });
    const totalLine = formatMetaLine({
      time: totals.time,
      cost: totals.cost,
      prefix: "Total: ",
    });
    metaEl.innerHTML = `${estimateLine}${totalLine}`;
  }

  STATUS_CLASS_NAMES.forEach((className) => {
    nodeEl.classList.remove(className);
  });
  const statusClass = STATUS_CLASS_MAP.get(selected.status);
  if (statusClass) {
    nodeEl.classList.add(statusClass);
  }

  ASSIGNEE_CLASS_NAMES.forEach((className) => {
    nodeEl.classList.remove(className);
  });
  const assigneeClass = ASSIGNEE_CLASS_MAP.get(selected.assignedTo);
  if (assigneeClass) {
    nodeEl.classList.add(assigneeClass);
  }
}

function updateConnections() {
  connectionsList.innerHTML = "";
  if (!selectedNodeId) {
    return;
  }

  const selected = state.nodes.find((node) => node.id === selectedNodeId);
  if (!selected) {
    return;
  }

  const links = state.links.filter(
    (link) => link.from === selectedNodeId || link.to === selectedNodeId
  );

  if (links.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No connections yet.";
    connectionsList.appendChild(empty);
    return;
  }

  links.forEach((link) => {
    const li = document.createElement("li");
    const fromNode = state.nodes.find((node) => node.id === link.from);
    const toNode = state.nodes.find((node) => node.id === link.to);
    const label = `${fromNode?.name || "Unknown"} → ${
      toNode?.name || "Unknown"
    }`;
    li.textContent = label;

    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.links = state.links.filter((item) => item.id !== link.id);
      saveState();
      render();
    });

    li.appendChild(remove);
    connectionsList.appendChild(li);
  });
}

function addNode({ parentId } = {}) {
  const newNode = {
    id: crypto.randomUUID(),
    name: "New Node",
    description: "",
    estimatedCost: 0,
    estimatedTime: 0,
    status: "Considering",
    assignedTo: "",
    positionLocked: false,
    position: null,
  };
  state.nodes.push(newNode);
  if (parentId) {
    state.links.push({
      id: crypto.randomUUID(),
      from: parentId,
      to: newNode.id,
    });
  }
  selectedNodeId = newNode.id;
  saveState();
  render();
}

function deleteNode() {
  if (!selectedNodeId) {
    return;
  }
  state.nodes = state.nodes.filter((node) => node.id !== selectedNodeId);
  state.links = state.links.filter(
    (link) => link.from !== selectedNodeId && link.to !== selectedNodeId
  );
  selectedNodeId = state.nodes[0]?.id ?? null;
  saveState();
  render();
}

function showLinkModal() {
  linkDependentSelect.innerHTML = "";
  linkRequiredSelect.innerHTML = "";
  state.nodes.forEach((node) => {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    linkDependentSelect.appendChild(option.cloneNode(true));
    linkRequiredSelect.appendChild(option);
  });

  if (selectedNodeId) {
    linkDependentSelect.value = selectedNodeId;
  }

  linkModal.classList.add("is-open");
  linkModal.setAttribute("aria-hidden", "false");
}

function hideLinkModal() {
  linkModal.classList.remove("is-open");
  linkModal.setAttribute("aria-hidden", "true");
}

function createLink() {
  const dependentId = linkDependentSelect.value;
  const requiredId = linkRequiredSelect.value;
  if (!dependentId || !requiredId || dependentId === requiredId) {
    return;
  }

  state.links.push({
    id: crypto.randomUUID(),
    from: requiredId,
    to: dependentId,
  });
  saveState();
  hideLinkModal();
  render();
}

function applyTransform() {
  mapContent.style.transform = `translate(${viewState.x}px, ${
    viewState.y
  }px) scale(${viewState.scale})`;
  linksLayer.style.transform = mapContent.style.transform;
}

function screenToMapPoint(clientX, clientY) {
  const rect = mapViewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - viewState.x) / viewState.scale,
    y: (clientY - rect.top - viewState.y) / viewState.scale,
  };
}

function fitToScreen() {
  const nodes = Array.from(mapContent.children);
  if (nodes.length === 0) {
    return;
  }
  const bounds = nodes.reduce(
    (acc, node) => {
      const rect = node.getBoundingClientRect();
      acc.minX = Math.min(acc.minX, rect.left);
      acc.minY = Math.min(acc.minY, rect.top);
      acc.maxX = Math.max(acc.maxX, rect.right);
      acc.maxY = Math.max(acc.maxY, rect.bottom);
      return acc;
    },
    {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    }
  );

  const viewportRect = mapViewport.getBoundingClientRect();
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scaleX = viewportRect.width / (width + 200);
  const scaleY = viewportRect.height / (height + 200);
  const scale = Math.min(scaleX, scaleY, 1);

  viewState.scale = scale;
  viewState.x = viewportRect.width / 2 - (bounds.minX + width / 2);
  viewState.y = viewportRect.height / 2 - (bounds.minY + height / 2);
  applyTransform();
}

function resetView() {
  viewState = { x: 0, y: 0, scale: 1 };
  applyTransform();
}

mapViewport.addEventListener("mousedown", (event) => {
  if (event.button !== 0) {
    return;
  }
  if (isNodeDragging) {
    return;
  }
  isDragging = true;
  mapViewport.classList.add("is-dragging");
  dragStart = { x: event.clientX, y: event.clientY };
  dragOrigin = { ...viewState };
});

mapViewport.addEventListener("mousemove", (event) => {
  if (isNodeDragging && draggedNodeId) {
    const mapPoint = screenToMapPoint(event.clientX, event.clientY);
    const node = state.nodes.find((item) => item.id === draggedNodeId);
    if (!node) {
      return;
    }
    const nextPosition = {
      x: mapPoint.x + dragOffset.x,
      y: mapPoint.y + dragOffset.y,
    };
    const rootStart = dragStartPositions.get(node.id) || node.position;
    const delta = rootStart
      ? {
          x: nextPosition.x - rootStart.x,
          y: nextPosition.y - rootStart.y,
        }
      : { x: 0, y: 0 };
    if (Math.abs(delta.x) > 2 || Math.abs(delta.y) > 2) {
      didDragNode = true;
    }
    const nodesById = new Map(state.nodes.map((item) => [item.id, item]));
    const idsToMove = draggedSubtreeIds.size
      ? draggedSubtreeIds
      : new Set([node.id]);
    idsToMove.forEach((nodeId) => {
      const startPosition = dragStartPositions.get(nodeId);
      if (!startPosition) {
        return;
      }
      const movedPosition = {
        x: startPosition.x + delta.x,
        y: startPosition.y + delta.y,
      };
      const movedNode = nodesById.get(nodeId);
      if (!movedNode) {
        return;
      }
      movedNode.position = { ...movedPosition };
      movedNode.positionLocked = true;
      layoutCache.positions.set(nodeId, { ...movedPosition });
      const nodeElement = mapContent.querySelector(
        `[data-node-id="${nodeId}"]`
      );
      if (nodeElement) {
        nodeElement.style.left = `${movedPosition.x}px`;
        nodeElement.style.top = `${movedPosition.y}px`;
      }
    });
    const nodeElements = new Map();
    mapContent.querySelectorAll(".node").forEach((element) => {
      const id = element.dataset.nodeId;
      const position = layoutCache.positions.get(id);
      nodeElements.set(id, { element, position });
    });
    const linkElements = [];
    linksLayer.querySelectorAll("path").forEach((path, index) => {
      const link = state.links[index];
      const arrows = linksLayer.querySelectorAll("circle");
      linkElements.push({
        from: link.from,
        to: link.to,
        path,
        arrow: arrows[index],
      });
    });
    updateLinkPositions(nodeElements, linkElements);
    return;
  }
  if (!isDragging) {
    return;
  }
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  viewState.x = dragOrigin.x + dx;
  viewState.y = dragOrigin.y + dy;
  applyTransform();
});

mapViewport.addEventListener("mouseup", () => {
  isDragging = false;
  if (isNodeDragging) {
    saveState();
  }
  isNodeDragging = false;
  draggedNodeId = null;
  draggedSubtreeIds = new Set();
  dragStartPositions = new Map();
  mapViewport.classList.remove("is-dragging");
});

mapViewport.addEventListener("mouseleave", () => {
  if (isDragging) {
    isDragging = false;
    mapViewport.classList.remove("is-dragging");
  }
  if (isNodeDragging) {
    saveState();
    isNodeDragging = false;
    draggedNodeId = null;
    draggedSubtreeIds = new Set();
    dragStartPositions = new Map();
  }
});

mapViewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = -event.deltaY * 0.0015;
  const nextScale = Math.min(Math.max(viewState.scale + delta, 0.3), 2);
  const rect = mapViewport.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const scaleRatio = nextScale / viewState.scale;

  viewState.x = offsetX - scaleRatio * (offsetX - viewState.x);
  viewState.y = offsetY - scaleRatio * (offsetY - viewState.y);
  viewState.scale = nextScale;
  applyTransform();
});

nodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  syncFormToState({ shouldRender: true });
});

nodeForm.addEventListener("input", () => {
  syncFormToState();
});

nodeForm.addEventListener("change", (event) => {
  const fieldName = event.target.name;
  const requiresRender = ["status", "estimatedCost", "estimatedTime"].includes(
    fieldName
  );
  syncFormToState({ shouldRender: requiresRender });
});

addRootButton.addEventListener("click", () => addNode());
addChildButton.addEventListener("click", () => {
  if (selectedNodeId) {
    addNode({ parentId: selectedNodeId });
  }
});

deleteNodeButton.addEventListener("click", deleteNode);
linkNodeButton.addEventListener("click", showLinkModal);
confirmLinkButton.addEventListener("click", createLink);
cancelLinkButton.addEventListener("click", hideLinkModal);
fitViewButton.addEventListener("click", fitToScreen);
resetViewButton.addEventListener("click", resetView);
sidebarToggleButton.addEventListener("click", () => {
  setSidebarCollapsed(true);
});
sidebarOpenButton.addEventListener("click", () => {
  setSidebarCollapsed(false);
});

mapViewport.addEventListener("click", () => {
  selectedNodeId = null;
  setSidebarCollapsed(true);
  render();
});

window.addEventListener("resize", () => {
  updateLinksBounds();
});

render();
fitToScreen();
