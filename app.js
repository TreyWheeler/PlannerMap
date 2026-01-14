const STORAGE_KEY = "plannerMapDataV1";
const NODE_WIDTH_RANGE = [170, 240];
const NODE_HEIGHT_RANGE = [120, 190];
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

let state = loadState();
let selectedNodeId = state.nodes[0]?.id ?? null;
let viewState = {
  x: 0,
  y: 0,
  scale: 1,
};
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let dragOrigin = { x: 0, y: 0 };

const STATUS_OPTIONS = [
  "Considering",
  "Shelved",
  "Committed",
  "In Progress",
  "Complete",
];

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

function computeLayout() {
  const { nodesById, childrenMap, incomingMap } = buildGraph();
  const primaryParent = new Map();

  state.nodes.forEach((node) => {
    const incoming = incomingMap.get(node.id) || [];
    primaryParent.set(node.id, incoming[0] || null);
  });

  const primaryChildren = new Map();
  state.nodes.forEach((node) => {
    const parentId = primaryParent.get(node.id);
    if (parentId) {
      if (!primaryChildren.has(parentId)) {
        primaryChildren.set(parentId, []);
      }
      primaryChildren.get(parentId).push(node.id);
    }
  });

  const roots = state.nodes
    .map((node) => node.id)
    .filter((id) => !primaryParent.get(id));

  const subtreeSize = new Map();

  function countLeaves(nodeId, trail = new Set()) {
    if (subtreeSize.has(nodeId)) {
      return subtreeSize.get(nodeId);
    }
    if (trail.has(nodeId)) {
      return 1;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(nodeId);
    const children = primaryChildren.get(nodeId) || [];
    if (children.length === 0) {
      subtreeSize.set(nodeId, 1);
      return 1;
    }
    const total = children.reduce(
      (sum, childId) => sum + countLeaves(childId, nextTrail),
      0
    );
    subtreeSize.set(nodeId, total);
    return total;
  }

  roots.forEach((rootId) => countLeaves(rootId));

  const positions = new Map();
  const levelSpacing = 280;
  const leafSpacing = 220;

  function layoutNode(nodeId, depth, yStart, trail = new Set()) {
    if (trail.has(nodeId)) {
      return;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(nodeId);
    const size = subtreeSize.get(nodeId) || 1;
    const yCenter = yStart + (size * leafSpacing) / 2;

    positions.set(nodeId, {
      x: depth * levelSpacing,
      y: yCenter,
    });

    let cursor = yStart;
    const children = primaryChildren.get(nodeId) || [];
    children.forEach((childId) => {
      const childSize = subtreeSize.get(childId) || 1;
      layoutNode(childId, depth + 1, cursor, nextTrail);
      cursor += childSize * leafSpacing;
    });
  }

  let rootCursor = 100;
  roots.forEach((rootId) => {
    const size = subtreeSize.get(rootId) || 1;
    layoutNode(rootId, 0, rootCursor);
    rootCursor += size * leafSpacing + 120;
  });

  state.nodes.forEach((node) => {
    if (!positions.has(node.id)) {
      positions.set(node.id, { x: 0, y: rootCursor });
      rootCursor += 200;
    }
  });

  return { positions, nodesById, childrenMap };
}

function render() {
  mapContent.innerHTML = "";
  linksLayer.innerHTML = "";

  const totalsById = computeTotals();
  const { positions } = computeLayout();
  const sizeValues = state.nodes.map((node) => {
    const totals = totalsById.get(node.id);
    return totals.cost + totals.time * ESTIMATED_RATE;
  });
  const minSize = Math.min(...sizeValues, 1);
  const maxSize = Math.max(...sizeValues, minSize + 1);

  const nodeElements = new Map();

  state.nodes.forEach((node) => {
    const totals = totalsById.get(node.id) || { cost: 0, time: 0 };
    const position = positions.get(node.id) || { x: 0, y: 0 };
    const totalEstimate = totals.cost + totals.time * ESTIMATED_RATE;
    const scaleValue = (totalEstimate - minSize) / (maxSize - minSize || 1);
    const width =
      NODE_WIDTH_RANGE[0] +
      (NODE_WIDTH_RANGE[1] - NODE_WIDTH_RANGE[0]) * scaleValue;
    const height =
      NODE_HEIGHT_RANGE[0] +
      (NODE_HEIGHT_RANGE[1] - NODE_HEIGHT_RANGE[0]) * scaleValue;

    const nodeEl = document.createElement("div");
    nodeEl.className = "node";
    if (node.status === "Shelved") {
      nodeEl.classList.add("node--shelved");
    }
    if (node.assignedTo === "Trey") {
      nodeEl.classList.add("node--trey");
    }
    if (node.assignedTo === "Sarah") {
      nodeEl.classList.add("node--sarah");
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

    nodeEl.innerHTML = `
      <div class="node__title">${node.name}</div>
      <div class="node__meta">
        <span>Estimated cost: $${node.estimatedCost.toLocaleString()}</span>
        <span>Estimated time: ${node.estimatedTime} hrs</span>
        <span>Total cost: $${totalCost.toLocaleString()}</span>
        <span>Total time: ${totalTime} hrs</span>
      </div>
    `;

    nodeEl.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedNodeId = node.id;
      updateForm();
      render();
    });

    mapContent.appendChild(nodeEl);
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
    const x1 = fromNode.position.x + fromNode.width / 2;
    const y1 = fromNode.position.y;
    const x2 = toNode.position.x - toNode.width / 2;
    const y2 = toNode.position.y;
    const midX = (x1 + x2) / 2;
    const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

    line.setAttribute("d", path);
    line.setAttribute("stroke", "#9aa3b2");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("fill", "none");
    linksLayer.appendChild(line);

    const arrow = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle"
    );
    arrow.setAttribute("cx", x2);
    arrow.setAttribute("cy", y2);
    arrow.setAttribute("r", "4");
    arrow.setAttribute("fill", "#4b8cff");
    linksLayer.appendChild(arrow);
  });

  updateForm();
  updateConnections();
  updateLinksBounds();
}

function updateLinksBounds() {
  const rect = mapViewport.getBoundingClientRect();
  linksLayer.setAttribute("width", rect.width);
  linksLayer.setAttribute("height", rect.height);
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
  isDragging = true;
  mapViewport.classList.add("is-dragging");
  dragStart = { x: event.clientX, y: event.clientY };
  dragOrigin = { ...viewState };
});

mapViewport.addEventListener("mousemove", (event) => {
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
  mapViewport.classList.remove("is-dragging");
});

mapViewport.addEventListener("mouseleave", () => {
  if (isDragging) {
    isDragging = false;
    mapViewport.classList.remove("is-dragging");
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
  render();
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

mapViewport.addEventListener("click", () => {
  selectedNodeId = null;
  render();
});

window.addEventListener("resize", () => {
  updateLinksBounds();
});

render();
fitToScreen();
