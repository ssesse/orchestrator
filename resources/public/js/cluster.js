clusterOperationPseudoGTIDMode = false;

function generateInstanceDivs(nodesMap) {
    nodesList = []
    for (var nodeId in nodesMap) {
        nodesList.push(nodesMap[nodeId]);
    } 

    $("[data-fo-id]").each(function () {
        var isVirtual = $(this).attr("data-fo-is-virtual") == "true";
        if (!isVirtual) {
	        $(this).html(
	        	'<div xmlns="http://www.w3.org/1999/xhtml" class="popover right instance"><div class="arrow"></div><h3 class="popover-title"></h3><div class="popover-content"></div></div>'
	        );
        }
    });
    nodesList.forEach(function (node) {
    	var popoverElement = $("[data-fo-id='" + node.id + "'] .popover");
   		renderInstanceElement(popoverElement, node, "cluster");
    });
    $("[data-fo-id]").each(
        function () {
            var id = $(this).attr("data-fo-id");
            var popoverDiv = $("[data-fo-id='" + id + "'] div.popover");

            popoverDiv.attr("x", $(this).attr("x"));
            $(this).attr("y",
                0 - popoverDiv.height() / 2 - 2);
            popoverDiv.attr("y", $(this).attr("y"));
            $(this).attr("width",
                popoverDiv.width() + 30);
            $(this).attr("height",
                popoverDiv.height() +16);
        });
    $("div.popover").popover();
    $("div.popover").show();
    
    $("[data-fo-id]").on("mouseenter", ".popover[data-nodeid]", function() {
    	if ($(".popover.instance[data-duplicate-node]").hasClass("ui-draggable-dragging")) {
    		// Do not remove & recreate while dragging. Ignore any mouseenter
    		return false;
    	}
    	var draggedNodeId = $(this).attr("data-nodeid"); 
    	if (draggedNodeId == $(".popover.instance[data-duplicate-node]").attr("data-nodeid")) {
    		return false;
    	}
    	$(".popover.instance[data-duplicate-node]").remove();
    	var duplicate = $(this).clone().appendTo("#cluster_container");
    	$(duplicate).attr("data-duplicate-node", "true");
    	//$(".popover.instance[data-duplicate-node] h3").addClass("label-primary");
    	$(duplicate).css({"margin-left": "0"});
    	$(duplicate).css($(this).offset());
    	$(duplicate).width($(this).width());
    	$(duplicate).height($(this).height());
    	$(duplicate).popover();
        $(duplicate).show();
        $(".popover.instance[data-duplicate-node] h3 a").click(function () {
        	openNodeModal(nodesMap[draggedNodeId]);
        	return false;
        });
        $(duplicate).draggable({
        	addClasses: true, 
        	opacity: 0.67,
        	cancel: "#cluster_container .popover.instance h3 a",
        	start: function(event, ui) {
        		resetRefreshTimer();
        		$("#cluster_container .accept_drop").removeClass("accept_drop");
        		$("#cluster_container .popover.instance").droppable({
        			accept: function(draggable) {
        				var draggedNode = nodesMap[draggedNodeId];
        				var targetNode = nodesMap[$(this).attr("data-nodeid")];
        				var acceptDrop =  moveInstance(draggedNode, targetNode, false);
        				if (acceptDrop) {
        					$(this).addClass("accept_drop");
        				}
        				return acceptDrop;
        			},
        			hoverClass: "draggable-hovers",
					drop: function( event, ui ) {
				        $(".popover.instance[data-duplicate-node]").remove();
				        moveInstance(nodesMap[draggedNodeId], nodesMap[$(this).attr("data-nodeid")], true);
					}
        		});
        	},
	    	drag: function(event, ui) {
	    		resetRefreshTimer();
	    	},
	    	stop: function(event, ui) {
	    		resetRefreshTimer();
        		$("#cluster_container .accept_drop").removeClass("accept_drop");
	    	}
        });
    	$(duplicate).on("mouseleave", function() {
    		if (!$(this).hasClass("ui-draggable-dragging")) {
	    		$(this).remove();
    		}
    	});
    	// Don't ask why the following... jqueryUI recognizes the click as start drag, but fails to stop...
    	$(duplicate).on("click", function() {
        	$("#cluster_container .accept_drop").removeClass("accept_drop");
        	return false;
        });	
    });
}

function moveInstance(node, droppableNode, shouldApply) {
	if (clusterOperationPseudoGTIDMode) {
		if (node.hasConnectivityProblem || droppableNode.hasConnectivityProblem) {
			return false;
		}
		if (!node.isSQLThreadCaughtUpWithIOThread) {
			return false;
		}
		if (instanceIsDescendant(node, droppableNode)) {
			if (shouldApply) {
				matchBelow(node, droppableNode);
			}
			return true;
		}
		if (isReplicationBehindSibling(node, droppableNode)) {
			if (shouldApply) {
				matchBelow(node, droppableNode);
			}
			return true;
		}
		// end pseudo-GTID mode
		return false;
	}
	// Not pseudo-GTID mode
	if (node.isCoMaster) {
		// Cannot move. RESET SLAVE on one of the co-masters.
		return false;
	}
	if (instancesAreSiblings(node, droppableNode)) {
		if (node.hasProblem || droppableNode.hasProblem) {
			return false;
		}
		if (shouldApply) {
			moveBelow(node, droppableNode);
		}
		return true;
	}
	if (instanceIsGrandchild(node, droppableNode)) {
		if (node.hasProblem) {
			// Typically, when a node has a problem we do not allow moving it up.
			// But there's a special situation when allowing is desired: when the parent has personal issues,
			// (say disk issue or otherwise something heavyweight running which slows down replication)
			// and you want to move up the slave which is only delayed by its master.
			// So to help out, if the instance is identically at its master's trail, it is allowed to move up.
			if (!node.isSQLThreadCaughtUpWithIOThread) { 
				return false;
			}
		}
		if (shouldApply) {
			moveUp(node, droppableNode);
		}
		return true;
	}
	if (instanceIsChild(droppableNode, node) && node.isMaster) {
		if (node.hasProblem) {
			return false;
		}
		if (shouldApply) {
			makeCoMaster(node, droppableNode);
		}
		return true;
	}
	
	if (shouldApply) {
		addAlert(
				"Cannot move <code><strong>" + 
					node.Key.Hostname + ":" + node.Key.Port +
					"</strong></code> under <code><strong>" +
					droppableNode.Key.Hostname + ":" + droppableNode.Key.Port +
					"</strong></code>. " +
				"You may only move a node down below its sibling or up below its grandparent."
			);
	}
	return false;
}

function moveBelow(node, siblingNode) {
	var message = "Are you sure you wish to turn <code><strong>" + 
		node.Key.Hostname + ":" + node.Key.Port +
		"</strong></code> into a slave of <code><strong>" +
		siblingNode.Key.Hostname + ":" + siblingNode.Key.Port +
		"</strong></code>?";
	bootbox.confirm(message, function(confirm) {
		if (confirm) {
			showLoader();
			var apiUrl = "/api/move-below/" + node.Key.Hostname + "/" + node.Key.Port + "/" + siblingNode.Key.Hostname + "/" + siblingNode.Key.Port;
		    $.get(apiUrl, function (operationResult) {
	    			hideLoader();
	    			if (operationResult.Code == "ERROR") {
	    				addAlert(operationResult.Message)
	    			} else {
	    				location.reload();
	    			}	
	            }, "json");					
		}
		$("#cluster_container .accept_drop").removeClass("accept_drop");
	}); 
	return false;
}


function moveUp(node, grandparentNode) {
	var message = "Are you sure you wish to turn <code><strong>" + 
		node.Key.Hostname + ":" + node.Key.Port +
		"</strong></code> into a slave of <code><strong>" +
		grandparentNode.Key.Hostname + ":" + grandparentNode.Key.Port +
		"</strong></code>?"
	bootbox.confirm(message, function(confirm) {
		if (confirm) {
			showLoader();
			var apiUrl = "/api/move-up/" + node.Key.Hostname + "/" + node.Key.Port;
		    $.get(apiUrl, function (operationResult) {
	    			hideLoader();
	    			if (operationResult.Code == "ERROR") {
	    				addAlert(operationResult.Message)
	    			} else {
	    				location.reload();
	    			}	
	            }, "json");					
		}
		$("#cluster_container .accept_drop").removeClass("accept_drop");
	}); 
	return false;
}


function makeCoMaster(node, childNode) {
	var message = "Are you sure you wish to make <code><strong>" + 
		node.Key.Hostname + ":" + node.Key.Port +
		"</strong></code> and <code><strong>" +
		childNode.Key.Hostname + ":" + childNode.Key.Port +
		"</strong></code> co-masters?"
	bootbox.confirm(message, function(confirm) {
		if (confirm) {
			showLoader();
			var apiUrl = "/api/make-co-master/" + childNode.Key.Hostname + "/" + childNode.Key.Port;
		    $.get(apiUrl, function (operationResult) {
	    			hideLoader();
	    			if (operationResult.Code == "ERROR") {
	    				addAlert(operationResult.Message)
	    			} else {
	    				location.reload();
	    			}	
	            }, "json");					
		}
		$("#cluster_container .accept_drop").removeClass("accept_drop");
	}); 
	return false;
}



function matchBelow(node, otherNode) {
	var message = "<h4>PSEUDO-GTID MODE</h4>Are you sure you wish to turn <code><strong>" + 
		node.Key.Hostname + ":" + node.Key.Port +
		"</strong></code> into a slave of <code><strong>" +
		otherNode.Key.Hostname + ":" + otherNode.Key.Port +
		"</strong></code>?";
	bootbox.confirm(message, function(confirm) {
		if (confirm) {
			showLoader();
			var apiUrl = "/api/match-below/" + node.Key.Hostname + "/" + node.Key.Port + "/" + otherNode.Key.Hostname + "/" + otherNode.Key.Port;
		    $.get(apiUrl, function (operationResult) {
	    			hideLoader();
	    			if (operationResult.Code == "ERROR") {
	    				addAlert(operationResult.Message)
	    			} else {
	    				location.reload();
	    			}	
	            }, "json");					
		}
		$("#cluster_container .accept_drop").removeClass("accept_drop");
	}); 
	return false;
}


function instancesAreSiblings(node1, node2) {
	if (node1.id == node2.id) return false;
	if (node1.masterNode == null ) return false;
	if (node2.masterNode == null ) return false;
	if (node1.masterNode.id != node2.masterNode.id) return false;
	return true;
}


function instanceIsChild(node, parentNode) {
	if (!node.hasMaster) {
		return false;
	}
	if (node.masterNode.id != parentNode.id) {
		return false;
	}
	if (node.id == parentNode.id) {
		return false;
	}
	return true;
}


function instanceIsGrandchild(node, grandparentNode) {
	if (!node.hasMaster) {
		return false;
	}
	var masterNode = node.masterNode;
	if (!masterNode.hasMaster) {
		return false;
	}
	if (masterNode.masterNode.id != grandparentNode.id) {
		return false;
	}
	if (node.id == grandparentNode.id) {
		return false;
	}
	return true;
}


function instanceIsDescendant(node, nodeAtQuestion) {
	if (nodeAtQuestion == null) {
		return false;
	}
	if (node.id == nodeAtQuestion.id) {
		return false;
	}
	if (!node.hasMaster) {
		return false;
	}
	if (node.masterNode.id == nodeAtQuestion.id) {
		return true;
	}
	return instanceIsDescendant(node.masterNode, nodeAtQuestion)
}

// Returns true when the two instances are siblings, and 'node' is behind or at same position
// (in reltation to shared master) as its 'sibling'.
// i.e. 'sibling' is same as, or more up to date by master than 'node'.
function isReplicationBehindSibling(node, sibling) { 
	if (!instancesAreSiblings(node, sibling)) {
		return false;
	} 
	return compareInstancesExecBinlogCoordinates(node, sibling) <= 0;
}

function compareInstancesExecBinlogCoordinates(i0, i1) {
	if (i0.ExecBinlogCoordinates.LogFile == i1.ExecBinlogCoordinates.LogFile) {
		// executing from same master log file
		return i0.ExecBinlogCoordinates.LogPos - i1.ExecBinlogCoordinates.LogPos;
	}
	return (getLogFileNumber(i0.ExecBinlogCoordinates.LogFile) - getLogFileNumber(i1.ExecBinlogCoordinates.LogFile));
	
}

function getLogFileNumber(logFileName) {
	logFileTokens = logFileName.split(".")
	return parseInt(logFileTokens[logFileTokens.length-1])
}


function analyzeClusterInstances(nodesMap) {
	instances = []
    for (var nodeId in nodesMap) {
    	instances.push(nodesMap[nodeId]);
    } 

    instances.forEach(function (instance) {
    	if (instance.isMaster && !instance.isCoMaster) {
		    if (instance.hasConnectivityProblem) {
		    	// The master has a connectivity problem! Do a client-size recommendation of best candidat.
		    	// Candidate would be a direct child of the master, with largest exec binlog coordinates.
		    	// There could be several children with same cordinates; we pick one.
		    	var sortedChildren = instance.children.slice(); 
		    	sortedChildren.sort(compareInstancesExecBinlogCoordinates)
		    	sortedChildren[sortedChildren.length - 1].isCandidateMaster = true
		    }
    	}
    });
}


function refreshClusterOperationModeButton() {
	if (clusterOperationPseudoGTIDMode) {
		$("#cluster_operation_mode_button").html("Pseudo-GTID mode");
		$("#cluster_operation_mode_button").removeClass("btn-success");
		$("#cluster_operation_mode_button").addClass("btn-warning");
	} else {
		$("#cluster_operation_mode_button").html("Safe mode");
		$("#cluster_operation_mode_button").removeClass("btn-warning");
		$("#cluster_operation_mode_button").addClass("btn-success");
	}
}

$(document).ready(function () {
    $.get("/api/cluster/"+currentClusterName(), function (instances) {
        $.get("/api/maintenance",
            function (maintenanceList) {
        		var instancesMap = normalizeInstances(instances, maintenanceList);
                analyzeClusterInstances(instancesMap);
                visualizeInstances(instancesMap);
                generateInstanceDivs(instancesMap);
            }, "json");
    }, "json");
    
    if (isPseudoGTIDModeEnabled()) {
        $("ul.navbar-nav").append('<li><a class="cluster_operation_mode"><button type="button" class="btn btn-xs" id="cluster_operation_mode_button"></button></a></li>');
        refreshClusterOperationModeButton();
        
	    $("body").on("click", "#cluster_operation_mode_button", function() {
	    	clusterOperationPseudoGTIDMode = !clusterOperationPseudoGTIDMode;
	    	refreshClusterOperationModeButton(); 
	    });
    }
    
    activateRefreshTimer();
});
